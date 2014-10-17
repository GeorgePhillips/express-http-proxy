var assert = require('assert');
var util = require('util');
var url = require('url');
var http = require('http');
var https = require('https');
var is = require('type-is');
var getRawBody = require('raw-body');


require('buffer');

module.exports = function proxy(host, options) {

	assert(host, 'Host should not be empty');

	options = options || {};

	var hostObj = null;

	if (typeof host == 'string') {
		hostObj = parseHost(host);
	}

	/** 
	 * intercept(data, res, req, function(err, json));
	 */
	var intercept = options.intercept;
	var decorateRequest = options.decorateRequest;
	var forwardPath = options.forwardPath;
	var filter = options.filter;
	var limit = options.limit || '1mb';

	return function handleProxy(req, res, next) {
		if (filter && !filter(req, res)) next();

		var headers = options.headers || {};
		var path;

		path = forwardPath ? forwardPath(req, res) : url.parse(req.url).path;

		var hds = extend(headers, req.headers, ['connection', 'host', 'content-length']);
		hds.connection = 'close';

		// var hasRequestBody = 'content-type' in req.headers || 'transfer-encoding' in req.headers;
		getRawBody(req, {
			length: req.headers['content-length'],
			limit: limit
		}, function(err, bodyContent) {
			if (err) return next(err);

			var reqOpt = {
				headers: hds,
				method: req.method,
				path: path,
				bodyContent: bodyContent
			};

			var tempHost = hostObj;
			if (!tempHost && typeof host != 'function') {
				tempHost = parseHost(host(req));
			}

			if (!tempHost) {
				next(new Error("No hostname provided"));
			}

			reqOpt.hostname = tempHost.host.toString();
			reqOpt.port = tempHost.port;

			if (decorateRequest)
				reqOpt = decorateRequest(reqOpt) || reqOpt;

			bodyContent = reqOpt.bodyContent;
			delete reqOpt.bodyContent;

			if (typeof bodyContent == 'string')
				reqOpt.headers['content-length'] = Buffer.byteLength(bodyContent);
			else if (Buffer.isBuffer(bodyContent)) // Buffer
				reqOpt.headers['content-length'] = bodyContent.length;

			var handler = http;
			if (reqOpt.port === 443) {
				handler = https;
			}

			var chunks = [];
			var realRequest = handler.request(reqOpt, function(rsp) {
				var rspData = null;
				rsp.on('data', function(chunk) {
					chunks.push(chunk);
				});

				rsp.on('end', function() {
					var totalLength = chunks.reduce(function(len, buf) {
						return len + buf.length;
					}, 0);

					var rspData = Buffer.concat(chunks, totalLength);

					if (intercept) {
						intercept(rspData, req, res, function(err, rsp, sent) {
							if (err) {
								return next(err);
							}
							
							if (typeof rsp == 'string') 
								rsp = new Buffer(rsp, 'utf8');
							
							if (!Buffer.isBuffer(rsp)) {
								next(new Error("intercept should return string or buffer as data"));
							}
							
							if (!res.headersSent)
								res.set('content-length', rsp.length);
							else if (rsp.length != rspData.length) {
								next(new Error("'Content-Length' is already sent, the length of response data can not be changed"));
							}

							if (!sent)
								res.send(rsp);
						});
					} else
						res.send(rspData);
				});

				rsp.on('error', function(e) {
					next(e);
				});


				if (!res.headersSent) { // if header is not set yet
					res.status(rsp.statusCode);
					for (var p in rsp.headers) {
						res.set(p, rsp.headers[p]);
					}
				}

			});

			realRequest.on('error', function(e) {
				next(e);
			});

			if (bodyContent.length) {
				realRequest.write(bodyContent);
			}

			realRequest.end();
		});
	};
};

function extend(obj, source, skips) {
	if (!source) return obj;

	for (var prop in source) {
		if (skips.indexOf(prop) == -1)
			obj[prop] = source[prop];
	}

	return obj;
}

function parseHost(host) {
	if (!host) return null;
	var mc = host.match(/^(https?:\/\/)/),
		port = 80;

	if (mc) {
		host = host.substring(mc[1].length);
		port = 443;
	}

	var h = host.split(':');
	
	return {
		host: h[0],
		port: h[1] || port
	};
}
