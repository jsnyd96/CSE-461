const net = require('net');

console.log('google CONNECT test');

var server = net.createServer(function(socket) {
	socket.on('data', function(data) {
		console.log('new stuff from browser:');

		var headerIndex = data.indexOf('\n\r\n');
		var header = data.toString('ascii', 0, headerIndex).trim();
		console.log(header + '\n');

		var headerLines = header.split('\n');
		var request = headerLines[0].trim();
		var tokens = request.split(' ');
		var requestType = tokens[0];
		var uri = tokens[1];

		for (var i = 1; i < headerLines.length; i++) {
			var line = headerLines[i].trim();
			headerLines[i] = line;

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

		console.log('>>> ' + requestType + ' ' + uri);

		request = request.replace(/HTTP\/\d+\.\d+/, 'HTTP/1.0');
		headerLines[0] = request;

		var headerString = '';
		for (var i = 0; i < headerLines.length; i++) {
			headerString += (headerLines[i] + '\r\n');
		}
		headerString += '\r\n';
		var headerBuffer = Buffer.from(headerString, 'ascii');
		var payload = data.slice(headerIndex + 3);

		console.log('finished parsing header:');
		console.log(headerString);

		if (requestType.toLowerCase() === 'connect') {
			var connectSocket = new net.Socket();

			connectSocket.connect(port, host, function() {
				console.log('connecting to google');

				socket.removeAllListeners('data');
				socket.on('data', function(data) {
					console.log('sending data to server:');
					//console.log(data.toString('utf-8'));
					connectSocket.write(data);
				});
				connectSocket.on('data', function(data) {
					console.log('sending stuff to browser:');
					//console.log(data.toString('utf-8'));
					socket.write(data);
				});

				connectSocket.on('end', function() {
					socket.removeAllListeners('data');
				});

				socket.write('HTTP/1.0 200 OK\r\n\r\n');
			});
		}

	});
});

server.listen(12345);
