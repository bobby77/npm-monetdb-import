var fs = require("fs");

var q = require("q");
var csvParse = require("csv-parse");
var fileExists = require("file-exists");
var isBinary = require("isbinaryfile");
var MonetDB = require("monetdb");
var CSVSniffer = require("csv-sniffer")();

// Private functions that are not tied to the Importer object and thus do not use the this keyword
function __typeCheck(type, valueToCheck, optional) {
    var correct = typeof(valueToCheck) == type;
    if(optional) {
        // Exception if the variable is optional, than it also may be undefined or null
        correct = correct || valueToCheck === undefined || valueToCheck === null;
    }
    if(!correct) {
        throw new Error("Invalid argument type received; expected "+type+
            ", but received "+typeof(valueToCheck));
    }
}

function __typeToDbType(type) {
    switch(type) {
        case "string":  return "STRING"; break;
        case "float":   return "DOUBLE"; break;
        case "integer": return "BIGINT"; break;
        default: 	    return "STRING"; break;
    }
}

function __labelFn(i) {
    return "c"+i;
}

function __labelTransformFn(label) {
    return label.toLowerCase()
        .replace(/\s/g, "_")
        .replace(/'/g, "")
        .replace(/"/g, "")
        .replace(/\n/g, " | ")
        .replace(/\r/g, "");
}


module.exports = function() {
    function Importer(dbOptions, importOptions, filepath, schemaname, tablename, delimiters) {
        // Shift if importOptions is missing
        if(typeof(importOptions) != "object") {
            // optional importOptions not provided, shift parameters
            delimiters = tablename;
            tablename = schemaname;
            schemaname = filepath;
            filepath = importOptions;
            importOptions = {};
        }
        // Shift if schemaname is missing
        if(typeof(tablename) != "string") {
            delimiters = tablename;
            tablename = schemaname;
            schemaname = "sys";
        }

        if(!fileExists(filepath)) {
            throw new Error("File '" + filepath + "' could not be found. Please check the path and try again.");
        }

        if(isBinary.sync(filepath)) {
            throw new Error("File '" + filepath + "' appears to be binary. We can only deal with regular text files.");
        }

        __typeCheck("object", dbOptions);
        __typeCheck("object", importOptions, true);
        __typeCheck("string", filepath);
        __typeCheck("string", schemaname, true);
        __typeCheck("string", tablename);
        __typeCheck("object", delimiters, true);

        // private variables
        var _conn = null;
        var _closeConn = false; // set to true if we create a connection ourselves
        var _filepath = filepath;
        var _schemaname = schemaname;
        var _tablename = tablename;
        var _importOptions = importOptions;
        var _bestEffort = false;
        var _labelFn = __labelFn;
        var _labelTransformFn = __labelTransformFn;
        var _sqlLogFn = console.log;
        var _sniffer = new CSVSniffer(delimiters);
        var _sample = null;

        // private functions
        function _query(query) {
            _sqlLogFn && _sqlLogFn(query);
            return _conn.queryQ(query);
        }

        function _getSample() {
            if(_sample) {
                return q.when(_sample);
            }
            return q.nfcall(fs.stat, _filepath).then(function(stat) {
                return q.nfcall(fs.open, _filepath, "r").then(function(fd) {
                    var bytesToRead = stat.size;
                    if(_importOptions.sampleSize > 0 && _importOptions.sampleSize < stat.size) {
                        bytesToRead = _importOptions.sampleSize;
                    }
                    var buf = new Buffer(bytesToRead);
                    return q.nfcall(fs.read, fd, buf, 0, bytesToRead, 0).then(function(bytesRead) {
                        _sample = buf.toString();
                        return _sample;
                    });
                });
            });
        }

        function _getTablename() {
            return '"'+_schemaname+'"."'+_tablename+'"';
        }



        var that = this;

        // priviliged functions (meaning they are public but can access the private variables)

        this.sniff = function(sniffOptions, fn) {
            if(typeof(sniffOptions) != "object") {
                // optional sniffOptions not provided, shift parameters
                fn = sniffOptions;
                sniffOptions = null;
            }
            __typeCheck("object", sniffOptions, true);
            __typeCheck("function", fn);

            _getSample().then(function(sample) {
                try {
                    var sniffResult = _sniffer.sniff(sample, sniffOptions);
                    // sniffResult calculated... make sure labels are appropriate for insertion in the database
                    Importer.prepareLabels(sniffResult, {labelFn: _labelFn, labelTransformFn: _labelTransformFn});
                    fn(null, sniffResult);
                } catch(err) {
                    fn("Failed to sniff file "+_filepath+" ("+err+")");
                }
            }, function(err) {
                fn("Could not sample file "+_filepath+" ("+err+")")
            });
        };


        this.import = function(sniffResult, fn) {
            // Check arguments and shift if necessary
            if(typeof(sniffResult) != "object") {
                fn = sniffResult;
                sniffResult = null;
            }
            __typeCheck("object", sniffResult, true);
            __typeCheck("function", fn);

            if(!sniffResult) {
                sniffResult = that.sniffQ();
            }

            var databaseCheckPromise = _query("SELECT COUNT(*) FROM "+_getTablename()).then(function() {
                // Query succeeded, meaning table exists...
                throw new Error("Table "+_getTablename()+" already exists!");
            }, function() {
                // Failure, which is exactly what we needed! Return true to resole promise
                return true;
            });

            var nrLines; // will be filled in on promise resolve

            q.spread([
                q.when(sniffResult),
                databaseCheckPromise
            ], function(sniffR) {
                sniffResult = sniffR; //Store globally so we don't have to pass it on to next promises

                // We have to walk through the entire file to figure out:
                // 1) Number of lines in the file, so we have an upper bound to give to the copy into statement
                // 2) Most occurring number of columns
                var nrColsP = q.defer();
                var nrCols = []; // e.g: [15: 60, 16: 1029, 17: 99, 18: 1, 99: 1] -> we would choose 16
                var parseOptions = {
                    delimiter: sniffResult.delimiter,
                    rowDelimiter: sniffResult.newlineStr,
                    quote: sniffResult.quoteChar,
                    skipEmptyLines: true,
                    trim: true
                };

                var csvParser = csvParse(parseOptions);

                csvParser.on("readable", function () {
                    var record;
                    var l;
                    while (record = csvParser.read()) {
                        l = record.length;
                        if (nrCols[l] === undefined) nrCols[l] = 1;
                        else nrCols[l]++;
                    }
                });

                csvParser.on("error", function (err) {
                    nrColsP.reject(err.message);
                });

                csvParser.on("finish", function () {
                    var maxNrCols = -1;
                    var chosenNrCols = -1;
                    nrCols.forEach(function (n, i) {
                        if (n && n > maxNrCols) {
                            maxNrCols = n;
                            chosenNrCols = i;
                        }
                    });
                    nrLines = csvParser.lines;
                    nrColsP.resolve(chosenNrCols);
                });

                fs.createReadStream(_filepath).pipe(csvParser);
                return nrColsP.promise;
            }).then(function(nrCols) {
                // Make sure we have the right amount of labels, and that the labels are valid (in case they came from the outside)
                Importer.prepareLabels(sniffResult, {labelFn: _labelFn, labelTransformFn: _labelTransformFn, nrCols: nrCols});

                // Create a table that can be used to store the file
                var labelsQuoted = sniffResult.labels.map(function(label) {
                    return '"'+label.replace('"', "")+'"';
                });
                return _query(
                    "CREATE TABLE "+_getTablename()+" ("+
                        labelsQuoted.map(function(col, i) {
                            return col+" "+__typeToDbType(sniffResult.types[i]);
                        }).join(",\n")+
                    ")"
                ).fail(function(err) {
                    throw new Error("Could not create database table "+_getTablename()+" ("+err+")");
                });
            }).then(function() {
                // Table is in place; we can now do the actual import
                var offset = sniffResult.hasHeader?"2":"1";
                var delimiterStr = null;
                if(sniffResult.delimiter) {
                    delimiterStr = "'"+sniffResult.delimiter+"'";
                    if(sniffResult.newlineStr) {
                        delimiterStr += ", '"+sniffResult.newlineStr.replace("\r", "\\r").replace("\n", "\\n")+"'";
                        if(sniffResult.quoteChar) {
                            delimiterStr += ", '"+sniffResult.quoteChar+"'";
                        }
                    }
                }
                var lockedStr = _importOptions.locked ? " LOCKED" : "";
                var bestEffortStr = _bestEffort ? " BEST EFFORT" : "";
                return _query( // Note: nrLines >= actual nr of records in input, but this is ok since MonetDB only expects an upper bound.
                    "COPY "+nrLines+" OFFSET "+offset+" RECORDS \n"+
                    "INTO "+_getTablename()+" \n"+
                    "FROM ('"+_filepath+"') \n"+
                    (delimiterStr ? "DELIMITERS "+delimiterStr+"\n" : "")+
                    "NULL AS '" + _importOptions.nullString + "'" + lockedStr + bestEffortStr);
            }).then(function() {
                if(!_bestEffort) return;
                // import succeeded and best effort used;
                // get the reject result, but do not fail when something fails, instead return no rejects
                return _query("SELECT * FROM sys.rejects").then(function (result) {
                    return result.data.map(function (row) {
                        return row.reduce(function (o, v, i) {
                            o[result.structure[i].column] = v;
                            return o;
                        }, {});
                    });
                }, function () {
                    return [];
                }).fin(function() {
                    _query("CALL sys.clearrejects()");
                });
            }).then(function(rejects) {
                fn && fn(null, rejects);
            }, function(err) {
                _query("DROP TABLE "+_getTablename());
                fn && fn("Import failed. Reason: "+err);
            }).fin(function() {
                if(_closeConn) {
                    _conn.close();
                }
            }).done();
        };

        this.bestEffort = function(b) {
            _bestEffort = !!b;
        };

        this.setLabelFn = function(fn) {
            __typeCheck("function", fn);
            _labelFn = fn;
        };

        this.setLabelTransformFn = function(fn) {
            __typeCheck("function", fn);
            _labelTransformFn = fn;
        };

        this.setSqlLogFn = function(fn) {
            __typeCheck("function", fn, true);
            _sqlLogFn = fn;
        };



        // initialize database connection
        if(dbOptions.conn) {
            _conn = dbOptions.conn;
        } else {
            _closeConn = true; // indicate that the connection should be closed afterwards
            _conn = MonetDB.connect(dbOptions, function(err) {
                if(err) {
                    throw new Error("Could not create a connection to the database: "+err);
                }
            });
        }
        if(!_conn.options.q) {
            _conn.options.q = q;
        }

        // initialize default options
        if(_importOptions.sampleSize === undefined) _importOptions.sampleSize = 0;
        if(_importOptions.locked === undefined)     _importOptions.locked = true;
        if(_importOptions.nullString === undefined) _importOptions.nullString = "";

    }

    // Static function that prepares the labels in the sniff result for insertion into the database,
    // by performing the following:
    // - Use the records array in the sniff result to determine the max number of columns in any row
    // - Extend the labels array to include enough values for the col max found in the previous step,
    //   or the number of cols provided in opts.nrCols, by using the label fn
    // - Apply label transform fn to all labels
    // - Replace any empty values with a label generated with the label fn
    // - Extend any duplicate values with '(i)'
    Importer.prepareLabels = function(sniffResult, opts) {
        if(!opts) opts = {};
        if(!opts.labelFn) {
            opts.labelFn = __labelFn;
        }
        if(!opts.labelTransformFn) {
            opts.labelTransformFn = __labelTransformFn;
        }
        var nrCols = 0;
        if(opts.nrCols === undefined) {
            if (sniffResult.records) {
                // first, find the # of columns that occurs the most in the records
                var colCountOccurrences = [];
                sniffResult.records.forEach(function (cols) {
                    if (!colCountOccurrences[cols.length]) {
                        colCountOccurrences[cols.length] = 1;
                    } else {
                        ++colCountOccurrences[cols.length];
                    }
                });
                Object.keys(colCountOccurrences).forEach(function (d) {
                    nrCols = Math.max(nrCols, parseInt(d));
                });
            }
            if (!sniffResult.labels) sniffResult.labels = [];
        } else {
            nrCols = parseInt(opts.nrCols);
            if(isNaN(nrCols)) nrCols = 0;
        }
        for(var i=0; i<nrCols; ++i) {
            if (typeof(sniffResult.labels[i]) != "string") {
                sniffResult.labels[i] = opts.labelFn((i + 1));
            }
        }
        sniffResult.labels = sniffResult.labels.slice(0, nrCols);

        // Transform labels and replace empty labels with labels created with the labelFn
        sniffResult.labels = sniffResult.labels.map(function(label, i) {
            var transformed = opts.labelTransformFn(label).trim();
            return transformed.length ? transformed : opts.labelFn(i + 1);
        });

        // Duplicate elimination
        var labelDict = {};
        sniffResult.labels = sniffResult.labels.map(function(label) {
            var res = label;
            var count = labelDict[label];
            if(count === undefined) {
                count = labelDict[label] = 0;
            } else {
                res += "(" + count + ")";
            }
            labelDict[label] = ++count;
            return res;
        });
    };

    // Q Integration
    ["sniff", "import"].forEach(function(funToQ) {
        var funQ = funToQ + 'Q';
        Importer.prototype[funQ] = function() {
            return q.npost(this, funToQ, arguments);
        }
    });

    return Importer;
};
