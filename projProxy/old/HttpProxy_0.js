const net = require('net');
const readline = require('readline');

var serverBuffers = new Map();
var clientBuffers = new Map();
var serverStreams = new Map();
var clientStreams = new Map();

var server = net.createServer(function(socket) {

	socket.on('error', function(err) {
		console.log(err.message);
	});

	socket.on('end', function() {
		socket.removeAllListeners('data');
	});

	socket.on('data', function(data) {
		// console.log(data.toString('ascii', 0, 40));

		if (serverStreams.get(socket)) {
			serverStreams.get(socket).write(data);
			return;
		}


		// Extract/buffer header
		var headerIndex = data.indexOf('\n\r\n');
		if (headerIndex < 0) {
			if (serverBuffers.get(socket)) {
				var buf = serverBuffers.get(socket);
				serverBuffers.set(socket, Buffer.concat([buf, data]));
			} else {
				serverBuffers.set(socket, data);
			}
			return;
		}
		
		if (serverBuffers.get(socket)) {
			var buf = serverBuffers.get(socket);
			data = Buffer.concat([buf, data]);
			headerIndex = data.indexOf('\n\r\n');
			serverBuffers.delete(socket);
		}

		var header = data.toString('ascii', 0, headerIndex).trim();
		var headerLines = header.split('\n');


		// Begin header parsing
		var request = headerLines[0].trim();
		var tokens = request.split(' ');
		var requestType = tokens[0];
		var uri = tokens[1];

		var blocked = ['firefox', 'mozilla'];
		for (var i = 0; i < blocked.length; i++) {
			if (uri.includes(blocked[i])) {
				return;
			}
		}


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
			connectSocket = new net.Socket();

			connectSocket.on('error', function(error) {
				console.log('error in connect tunnel: ' + error.message);
				socket.write('HTTP/1.0 502 Bad Gateway\r\n\r\n');
				socket.end();
			});

			connectSocket.connect(port, host, function() {
				socket.removeAllListeners('data');
				socket.on('data', function(data) {
					connectSocket.write(data);
				});

				socket.write('HTTP/1.0 200 OK\r\n\r\n');
				console.log('tunnel payload' + payload.toString('ascii'));
				connectSocket.write(payload);

				connectSocket.on('data', function(data) {
					socket.write(data);
				});

				connectSocket.on('end', function() {
					socket.removeAllListeners('data');
				});
			});
			return;
		}


		responseSocket = new net.Socket();

		responseSocket.on('error', function(error) {
			console.log('error from server: ' + error.message);
		});

		responseSocket.connect(port, host, function() {
			responseSocket.on('data', function(responseData) {
				// console.log("Response: " + responseData.toString('ascii'));
				console.log("got stuff for " + uri);

				if (clientStreams.get(uri)) {
					socket.write(responseData);
					console.log("more payload for " + uri);					
					return;
				}

				var responseHeaderIndex = responseData.indexOf('\n\r\n');

				if (responseHeaderIndex < 0) {
					if (clientBuffers.get(uri)) {
						var buf = clientBuffers.get(uri);
						clientBuffers.set(uri, Buffer.concat([buf, responseData]));
					} else {
						clientBuffers.set(uri, responseData);
					}
					console.log("buffering header for " + uri);
					return;
				}
	
				if (clientBuffers.get(responseSocket)) {
					var buf = clientBuffers.get(responseSocket);
					responseData = Buffer.concat([buf, responseData]);
					responseHeaderIndex = responseData.indexOf('\n\r\n');
					clientBuffers.delete(uriSocket);
				}

				clientStreams.set(uri, responseSocket);
				

				var responseHeader = responseData.toString('ascii', 0, responseHeaderIndex).trim();
				var responseLines = responseHeader.split('\n');
				console.log('RESPONSE FROM ' + uri);
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

				// console.log("Got response: " + responseString);
				// var responseBytes = Buffer.concat([Buffer.from(responseString, 'ascii'), 
				//				responseData.slice(responseHeaderIndex + 3)]);
				// socket.write(responseData);
				socket.write(Buffer.from(responseString, 'ascii'));
				socket.write(responseData.slice(responseHeaderIndex + 3));
			});

			serverStreams.set(socket, responseSocket);
			console.log("Request sent: " + headerString);
			// var bytes = Buffer.concat([Buffer.from(headerString, 'ascii'), data.slice(headerIndex + 3)]);
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




