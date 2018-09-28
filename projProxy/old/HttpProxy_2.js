const net = require('net');
const readline = require('readline');

var buffers = new Map();
var tunnels = new Map();
var streams = new Map();

var server = net.createServer(function(socket) {
	socket.on('error', function(err) {
		console.log(err);
	});

	socket.on('end', function(err) {
		buffers.delete(socket);
		streams.delete(socket);
		tunnels.delete(socket);
	});

	socket.on('data', function(data) {

		if (streams.get(socket)) {
			streams.get(socket).write(data);
			return;
		}

		if (tunnels.get(socket)) {
			tunnels.get(socket).write(data);
			return;
		}


		// Extract/buffer header
		var headerIndex = data.indexOf('\n\r\n');

		if (headerIndex < 0) {
			if (buffers.get(socket)) {
				var buf = buffers.get(socket);
				buffers.set(socket, Buffer.concat([buf, data]));
			} else {
				buffers.set(socket, data);
			}
			return;
		}
		
		if (buffers.get(socket)) {
			var buf = buffers.get(socket);
			data = Buffer.concat([buf, data]);
			headerIndex = data.indexOf('\n\r\n');
			buffers.delete(socket);
		}

		var header = data.toString('ascii', 0, headerIndex).trim();
		var headerLines = header.split('\n');


		// Begin header parsing
		var request = headerLines[0].trim();
		var tokens = request.split(' ');
		var requestType = tokens[0];
		var uri = tokens[1];
/*
		var blocked = ['firefox', 'mozilla'];
		for (var i = 0; i < blocked.length; i++) {
			if (uri.includes(blocked[i])) {
				return;
			}
		}
*/

		for (var i = 1; i < headerLines.length; i++) {
			var line = headerLines[i].trim();
			headerLines[i] = line;
			// console.log(headerLines[i]);

			if (line.toLowerCase().startsWith('host:')) {
				var host = line.substring(5).trim();
				var port = 0;

				// check host line for port
				var index = host.indexOf(':');
				if (index > 0) {
					port = parseInt(host.substring(index + 1));
					host = host.substring(0, index);
					continue;
				}

				// check header for port
				index = request.indexOf(":");
				if (index > 0) {
					port = parseInt(request.substring(index + 1));
				}

				if (port) {
					continue;
				// check for http/https to get default port
				} else if (request.includes("https://")) {
					port = 443;
				} else if (request.includes("http://")) {
					port = 80;
				}
			} else if (line.toLowerCase().startsWith('connection:')) {
				headerLines[i] = 'Connection: close';
			} else if (line.toLowerCase().startsWith('proxy-connection:')) {
				headerLines[i] = 'Proxy-Connection: close';
			}
		}

		// Print the proxy request
		console.log('>>> ' + requestType + ' ' + uri);
		if (!port) {
			console.log("Error: couldn't parse port");
			return;
		}
		// console.log('host = ' + host + ':' + port + '\n');


		// Various request tweaks
		if (requestType.toLowerCase() === 'get' || requestType.toLowerCase() === 'post' ) {
			var path = uri.substring(uri.indexOf(host) + host.length);
			request = requestType + ' ' + path + ' HTTP/1.0';
		} else {
			request = request.replace(/HTTP\/\d+\.\d+/, 'HTTP/1.0');
		}
		headerLines[0] = request;
		
		
		// Create buffer for new header
		var headerString = '';
		for (var i = 0; i < headerLines.length; i++) {
			// console.log(headerLines[i]);
			headerString += (headerLines[i] + '\r\n');
		}
		headerString += '\r\n';
		var headerBuffer = Buffer.from(headerString, 'ascii');
		var payload = data.slice(headerIndex + 3);




		// Begin request forwarding
		if (requestType.toLowerCase() === 'connect') {
			var connectSocket = new net.Socket();
/*
			connectSocket.on('error', function(err) {
				socket.write('HTTP/1.0 502 Bad Gateway\r\n\r\n', 'ascii');
				console.log('error in connect tunnel');
				socket.end();
			});
*/
			connectSocket.connect(port, host, function() {
				connectSocket.on('data', function(data) {
					socket.write(data);
				});

				connectSocket.on('end', function() {
					socket.end();
				});

				tunnels.set(socket, connectSocket);
				socket.write('HTTP/1.0 200 OK\r\n\r\n', 'ascii');

				// console.log(headerString);
				
				connectSocket.write(payload);
			});

			return;
		}

		responseSocket = new net.Socket();
		
		responseSocket.on('error', function(err) {
			console.log('error forwarding request');
			socket.end();
		});


		responseSocket.connect(port, host, function() {
			responseSocket.on('end', function(err) {
				buffers.delete(responseSocket);
				streams.delete(responseSocket);
				socket.end();
			});

			// TODO: time schedule doesn't load images right
			responseSocket.on('data', function(data) {
				if (streams.get(responseSocket)) {
					socket.write(data);				
					return;
				}

				var responseHeaderIndex = data.indexOf('\n\r\n');

				if (responseHeaderIndex < 0) {
					if (buffers.get(responseSocket)) {
						var buf = cbuffers.get(responseSocket);
						buffers.set(responseSocket, Buffer.concat([buf, data]));
					} else {
						buffers.set(responseSocket, data);
					}
					return;
				}
	
				if (buffers.get(responseSocket)) {
					var buf = buffers.get(responseSocket);
					responseData = Buffer.concat([buf, data]);
					responseHeaderIndex = data.indexOf('\n\r\n');
					buffers.delete(responseSocket);
				}

				streams.set(responseSocket, true);
				
				var responseHeader = data.toString('ascii', 0, responseHeaderIndex).trim();
				var responseLines = responseHeader.split('\n');
				var responseString = '';
				for (var i = 0; i < responseLines.length; i++) {
					responseLines[i] = responseLines[i].trim();
					if (responseLines[i].toLowerCase().startsWith('connection:')) {
						responseLines[i] = 'Connection: close';
					} else if (responseLines[i].toLowerCase().startsWith('proxy-connection:')) {
						responseLines[i] = 'Proxy-Connection: close';
					}
					responseString += (responseLines[i] + '\r\n');
				}
				responseString += '\r\n';		
				socket.write(Buffer.from(responseString, 'ascii'));
				socket.write(data.slice(responseHeaderIndex + 3));
			});

			streams.set(socket, responseSocket);
			responseSocket.write(headerBuffer);
			responseSocket.write(payload);
		});
	});
});


if (require.main === module) {
	if (process.argv.length !== 3) {
		console.log('Usage: ./run <proxy port>');
		process.exit();
	}

	proxyport = process.argv[2];
	console.log("HttpProxy listening on " + proxyport);

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	rl.on('SIGINT', function(line) {
		console.log('^C');
		process.exit();
	});

	rl.on('close', function(line) {
		console.log('^D');
		process.exit();
	});

	server.listen(proxyport);
}




