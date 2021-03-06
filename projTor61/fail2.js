const net = require('net');
const regService = require('./RegistrationClient');
const readline = require('readline');

//TODO: Not really a problem right now before testing, but ASCII encoding is the encoding used for Tor61, so if we have problems, we could check encoding first

var group;
var instance;
var proxyPort;
var registrationName;
var routerName;

const CELL_SIZE = 512;

const CELL_CREATE = 1;
const CELL_CREATED = 2;
const CELL_RELAY = 3;
const CELL_DESTROY = 4;
const CELL_OPEN = 5;
const CELL_OPENED = 6;
const CELL_OPEN_FAILED = 7;
const CELL_CREATE_FAILED = 8;

const RELAY_BEGIN = 1;
const RELAY_DATA = 2;
const RELAY_END = 3;
const RELAY_CONNECTED = 4;
const RELAY_EXTEND = 6;
const RELAY_EXTENDED = 7;
const RELAY_BEGIN_FAILED = 11;
const RELAY_EXTEND_FAILED = 12;

const TIMEOUT = 3000;



var routingTable = new Map(); // Maps (incoming socket) to a map mapping (incoming circuit) to (outgoing circuit, outgoing socket)
// Outgoing circuit is named circuit, outgoing socket is socket

var circuits = new Map(); // Maps router names (agent ids) to next circuit number for that router

var streams = new Map(); // Maps browser sockets to Tor stream numbers

// Map for when we're the last router in a circuit and we need to decide which web server to send to
var browserStreams = new Map(); // Incoming socket -> circuit number -> stream number -> outgoing socket

var connections = new Map(); // Maps router names to sockets (socket to that router)

var routingData = new Map() // Maps (outgoing socket) to a map mapping (outgoing circuit) to (incoming circuit, incoming socket); 

var sourceSocket;
var sourceCircuit;
var streamCounter = 1;



function create(circuit) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt16BE(circuit, 0);
	cell.writeUInt8(CELL_CREATE , 2);
	return cell;
}

function created(circuit) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt16BE(circuit, 0);
	cell.writeUInt8(CELL_CREATED , 2);
	return cell;
}

function relay(circuit, stream, relayCmd, body) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt16BE(circuit, 0);
	cell.writeUInt8(CELL_RELAY, 2);
	cell.writeUInt16BE(stream, 3);
	cell.writeUInt16BE(Buffer.byteLength(body), 11);
	cell.writeUInt8(relayCmd, 13);
	cell.write(body, 14);
	return cell;
}

function destroy(circuit) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt16BE(circuit, 0);
	cell.writeUInt8(CELL_DESTROY , 2);
	return cell;
}

function open(src, dst) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt8(CELL_OPEN, 2);
	cell.writeUInt32BE(src, 3);
	cell.writeUInt32BE(src, 7);
	return cell;
}

function opened(src, dst) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt8(CELL_OPENED, 2);
	cell.writeUInt32BE(src, 3);
	cell.writeUInt32BE(src, 7);
	return cell;
}

function openFail(src, dst){
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt8(CELL_OPEN_FAIL, 2);
	cell.writeUInt32BE(src, 3);
	cell.writeUInt32BE(src, 7);
	return cell;
}

function createFail(circuit) {
	var cell = Buffer.alloc(CELL_SIZE);
	cell.writeUInt16BE(circuit, 0);
	cell.writeUInt8(CELL_CREATE_FAILED , 2);
	return cell;
}

function shutdown() {
	// TODO: full cleanup
	sourceSocket.write(destroy(sourceCircuit));

	console.log('SHUTDOWN');
	// This calls process.exit
	regService.quit();

}

// TODO: Might want to remove this at the end
//process.on('uncaughtException', function(err) {
//	console.log("GLOBAL ERROR: " + err);
//	shutdown();
//});

// Socket waiting for connections from other Tor61 routers
var connectionSocket = net.createServer(function(socket) {
	socket.on('data', function(data) {
		var cellType = data.readUInt8(2);

		if (cellType === CELL_DESTROY) {
			//cleanup
			return;
		} else if (cellType === CELL_OPEN) {
			// Add new connection to connections
			console.log('Got OPEN!');
			var agentId = data.readUInt32BE(3);
			connections.set(agentId, socket);
			circuits.set(agentId, 2);


			var response = data;
			response.writeUInt8(CELL_OPENED, 2);
			socket.write(response);
	
		} else if (cellType === CELL_OPEN_FAILED) {

		} else if (cellType === CELL_OPENED) {

		} else if (cellType === CELL_CREATE) {
			console.log("Got CREATE!");
			var circuit = data.readUInt16BE(0);
			var response = data;
			response.writeUInt8(CELL_CREATED, 2);

			socket.write(response);
			if (!routingTable.has(socket)) {
				routingTable.set(socket, new Map());
			} 
			//routingTable.get(socket).set(circuit, null);

		} else if (cellType === CELL_CREATE_FAILED) {
			console.log("Got CREATE_FAIL");
			var circuit = data.readUInt16BE(0);
			var incoming = routingData.get(socket).get(circuit).socket;

			routingData.delete(inSocket);
			routingData.delete(socket);
			incoming.socket.write(relay(incoming.circuit, 0, RELAY_EXTEND_FAILED, ""));

		} else if (cellType === CELL_CREATED) {
			console.log("Server socket got CREATED");
			var circuit = data.readUInt16BE(0);
			var incoming = routingData.get(socket).get(circuit);

			var inCircuit = incoming.circuit;
			var inSocket = incoming.socket;

			if (!routingTable.has(socket)) {
				routingTable.set(socket, new Map());
			}

			routingTable.get(inSocket).set(inCircuit, {'circuit' : circuit, 'socket' : socket});
			routingTable.get(socket).set(circuit, {'circuit' : inCircuit, 'socket' : inSocket});
			routingData.delete(inSocket);
			routingData.delete(socket);

			inSocket.write(relay(inCircuit, 0, RELAY_EXTENDED, ""));

		} else if (cellType === CELL_RELAY) {
			var circuit = data.readUInt16BE(0);
			var stream = data.readUInt16BE(3);
			var relayType = data.readUInt8(13);
			var body = data.toString('ascii', 14);
			if (relayType === RELAY_BEGIN) {
				var nextRouter = routingTable.get(socket).get(circuit);
				if (!nextRouter) {
					// We're the last router in the circuit - create a connection with the requested web server
					var host = body.substring(0, body.indexOf(":"));
					var port = body.substring(body.indexOf(":") + 1, body.indexOf("\0"));
					var bSocket = new net.Socket();
					bSocket.on('error', function(err) {
						console.log("Could not connect to " + host + ":" + port);
						socket.write(relay(circuit, stream, RELAY_BEGIN_FAILED, ""));
					});
					var browserSocket = bSocket;
					var inSocket = socket;
					bSocket.connect(port, host, function() {
						inSocket.write(relay(circuit, stream, RELAY_CONNECTED, ""));
						browserSocket.on('data', function(data) {
							// 498 is the max size of the body
							// If the data is smaller than 498, slice will still work properly
							while(Buffer.byteLength(data) > 0) {
								inSocket.write(relay(circuit, stream, RELAY_DATA, data.slice(0, 498)));
								data = data.slice(498);
							}
						});
					});
					if (!browserStreams.has(inSocket)) {
						browserStreams.set(inSocket, new Map());
					}
					if (!browserStreams.has(circuit)) {
						browserStreams.get(inSocket).set(circuit, new Map());
					}
					// Seems kind of ugly, making do with it at the moment
					browserStreams.get(inSocket).get(circuit).set(stream, browserSocket);
				} else {
					var begin = relay(nextRouter.circuit, stream, RELAY_BEGIN, body);
					nextRouter.socket.write(begin);
				}
			} else if (relayType === RELAY_DATA) {
				var nextRouter = routingTable.get(socket).get(circuit);
				if (!nextRouter) {
					browserStreams.get(socket).get(circuit).get(stream).write(body);
				} else {
					var relayData = relay(nextRouter.circuit, stream, RELAY_DATA, body);
					nextRouter.socket.write(relayData);
				}
			} else if (relayType === RELAY_END) {
				var nextRouter = routingTable.get(socket).get(circuit);
				if (!nextRouter) {
					browserStreams.get(socket).get(circuit).delete(stream);
				} else {
					var end = relay(nextRouter.circuit, stream, RELAY_END, body);
					nextRouter.socket.write(end);
				}
			} else if (relayType === RELAY_CONNECTED) {
				
			} else if (relayType === RELAY_EXTEND) {
				var nextRouter = routingTable.get(socket).get(circuit);
				if (!nextRouter) {
					var ip = body.substring(0, body.indexOf(":"));
					var port = parseInt(body.substring(body.indexOf(":") + 1, body.indexOf("\0")));
					var agentId = parseInt(body.substring(body.indexOf("\0") + 1));

					if (connections.has(agentId)) {

						// we don't have to do anything if we are extending to ourself
						if (agentId == routerName) {
							socket.write(relay(circuit, 0, RELAY_EXTENDED, ""));
							return;
						}

						console.log("Relay extend landed here");
						var nextCircuit = circuits.get(agentId);
						circuits.set(agentId, nextCircuit + 2);

						var nextRouter = connections.get(agentId);

						routingData.set(nextRouter, new Map());
						routingData.get(nextRouter).set(nextCircuit, {'circuit' : circuit, 'socket' : socket});

						nextRouter.write(create(nextCircuit));

						// var timer = setTimeout(function() {
						//  	socket.write(relay(circuit, 0, RELAY_EXTEND_FAILED, ""));
						// }, TIMEOUT);

					} else {
						console.log('Opening new Tor connection');
						var inSocket = socket;
						var inCircuit = circuit;

						// open a new socket
						var cSocket = new net.Socket();
						var circuitSocket = cSocket;
						cSocket.connect(port, ip, function() {
							
							//TODO: add a TON of handlers: basically copy the below stuff
							// send CREATE on OPENED
							// send back RELAY_EXTENDED on CREATED
							// fill routing table on CREATED
							// remove handler?
							// what if open/create fails?

							circuitSocket.on('data', function(data) {
								var cellType = data.readUInt8(2);

								if (cellType === CELL_OPENED) {
									console.log("Inner socket got OPENED");
									circuitSocket.write(create(1));
								} else if (cellType === CELL_CREATED) {
									console.log("Inner socket got CREATED");
									// connections.set(agentId, );

									routingTable.get(inSocket).set(inCircuit, {'circuit' : 1, 'socket' : circuitSocket});
									routingTable.set(circuitSocket, new Map());
									routingTable.get(circuitSocket).set(1, {'circuit' : inCircuit, 'socket' : inSocket});
									socket.write(relay(inCircuit, 0, RELAY_EXTENDED, ""));
								} else if (cellType === CELL_RELAY) {

									var relayType = data.readUInt8(13);
									var circuit = data.readUInt16BE(0);

									console.log('Inner socket got relay ' + relayType);

									if (relayType === RELAY_EXTEND) {
										//TODO: last extend
									} else if (relayType === RELAY_EXTEND_FAILED) {
										
									} else if (relayType === RELAY_EXTENDED) {
										socket.write(relay(circuit, data.readUInt16BE(3), RELAY_EXTENDED, ""));
									} else if (relayType === RELAY_CONNECTED) {
										socket.write(relay(circuit, data.readUInt16BE(3), RELAY_CONNECTED, ""));
									}
								} else if (cellType === CELL_CREATE) {
									circuitSocket.write(createFail(circuit));
									return;
								} else {
									
								}
							});

							// send CREATE on success, send back RELAY_EXTEND_FAIL on fail
							circuitSocket.write(open(routerName, agentId));
						});

					} 
				} else {
					nextRouter.socket.write(relay(nextRouter.circuit, stream, RELAY_EXTEND, body));
				}
			} else {
				// Bad Relay
				shutdown();
			}
		} else {
			// Bad cell
			shutdown();
		}
	});
}).listen();

if (require.main === module) {
	if (process.argv.length !== 5) {
		console.log('Usage: ./run <group#> <instance#> <proxy port>');
		process.exit();
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	rl.on('SIGINT', function(line) {
		console.log('^C');
		shutdown();
	});

	rl.on('close', function(line) {
		console.log('^D');
		shutdown();
	});


	group = parseInt(process.argv[2]);
	instance = parseInt(process.argv[3]);
	proxyPort = parseInt(process.argv[4]);

	groupStr = process.argv[2];
	instanceStr = process.argv[3];
	while (groupStr.length < 4) {
		groupStr = "0" + groupStr;
	}
	while (instanceStr.length < 4) {
		instanceStr = "0" + instanceStr;
	}
	registrationName = "Tor61Router-" + groupStr + "-" + instanceStr;
	routerName = (group << 16) | instance;

	// *********************************
	// *         BEGIN STARTUP         *
	// *********************************

	var startupState = 0;
	// 0: waiting for opened
	// 1: waiting for created
	// 2: waiting for relay extended 1
	// 3: waiting for relay extended 2
	// 4:

	registeredCallback = function(err) {
		if (err) {
			console.log("ERROR: couldn\'t register router");
			process.exit();
		} 
				
		fetchedCallback = function(err, entries) {
			if (err) {
				console.log("ERROR: couldn\'t fetch routers");
				shutdown();
			}

			// console.log('Fetched router list');

			// Entries is a list of available routers
			// Routers are removed on relay extend fails
			// If entries empty, quit

			var entryIndex = Math.floor(Math.random() * entries.length);
			var entry = entries[entryIndex];
			
			var cSocket = new net.Socket();
			var circuitSocket = cSocket;
			sourceSocket = circuitSocket;

			var timer;

			cSocket.connect(entry.entryPort, entry.entryIp, function() {
				circuitSocket.on('data', function(responseData) {

					var cellType = responseData.readUInt8(2);

					// Disable timeout
					circuitSocket.setTimeout(0);

					if (cellType === CELL_OPENED) {
						console.log("Creating circuit 1 with router 0x" + entry.entryData.toString(16));

						if (entry.entryData != routerName) {
							connections.set(entry.entryData, circuitSocket);
						}

						circuits.set(entry.entryData, 3);
						circuitSocket.write(create(1));
						circuitSocket.setTimeout(TIMEOUT);
						return;

					} else if (cellType === CELL_CREATE) {
						// console.log('panic! create sent to startup socket! sending fail!');
						
						var circuit = responseData.readUInt16BE(0);
						circuitSocket.write(created(circuit));
						return;

					} else if (cellType === CELL_OPEN_FAILED) {
						console.log('ERROR: couldn\'t establish startup circuit (open failed)');
						return shutdown();

					} else if (cellType === CELL_CREATE_FAILED) {
						console.log('ERROR: couldn\'t establish startup circuit (create failed)');
						return shutdown();

					} else if (cellType === CELL_CREATED) {
						// TODO: Map (circuit #, http socket (?)) to (circuit #, circuitSocket)
						// Do we need to do any mapping here?

						circuitSize = 1;
						var circuit = responseData.readUInt16BE(0);
						sourceCircuit = circuit;
						
						entryIndex = Math.floor(Math.random() * entries.length);
						entry = entries[entryIndex];

						console.log("First extend for circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
						circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));

					} else if (cellType === CELL_RELAY) {
						clearTimeout(timer);

						var relayType = responseData.readUInt8(13);
						var circuit = responseData.readUInt16BE(0);

						if (relayType === RELAY_EXTENDED) {
							circuitSize++;
							if (circuitSize < 3) {
								entryIndex = Math.floor(Math.random() * entries.length);
								entry = entries[entryIndex];

								console.log("Extending circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
								circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));

							} else {
								console.log("Creation of startup circuit " + circuit + " finished\n");
								console.log("HTTP proxy is up on port " + proxyPort);
								console.log("Tor61 router is up on port " + connectionSocket.address().port);
								
								// proxy.listen(proxyPort);
								// TODO: clear startup event listeners?

								// temporary test code
								sourceSocket.write(relay(1, 1, RELAY_BEGIN, 'courses.cs.washington.edu:80\0'));
								return;
							}
						} else if (relayType === RELAY_EXTEND_FAILED) {
							entries.splice(entryIndex, 1);
							if (entries.length === 0) {
								console.log('ERROR: couldn\'t establish startup circuit (no routers left)');
								return shutdown();
							}

							console.log("Failed extend for router 0x" + entry.entryData.toString(16) + ".");
							entryIndex = Math.floor(Math.random() * entries.length);
							entry = entries[entryIndex];

							console.log("Extending circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
							circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));

						} else if (relayType === RELAY_CONNECTED) {
							console.log('got CONNECTED');
							return;

						} else if (relayType === RELAY_BEGIN_FAILED) {

						} else if (relayType === RELAY_DATA) {


						} else {
							console.log('ERROR: Screwy protocol, got relay type ' + relayType + ' during startup');
							return shutdown();
						}
					} else {
						console.log('ERROR: Screwy protocol, got cell type ' + cellType + ' during startup');
						console.log(responseData.readUInt16BE(0));
						return shutdown();
					}

					// Relay extend timeout
					timer = setTimeout(function() {
						console.log('Relay extend timeout for router 0x' + entry.entryData.toString(16));
						entries.splice(entryIndex, 1);
						if (entries.length === 0) {
							console.log('ERROR: couldn\'t establish startup circuit (no routers left)');
							return shutdown();
						}

						entryIndex = Math.floor(Math.random() * entries.length);
						entry = entries[entryIndex];

						console.log("Extending circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
						circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));
					}, TIMEOUT);
				});

				console.log("Sending open to router 0x" + entry.entryData.toString(16));
				circuitSocket.write(open(routerName, entry.entryData));

				circuitSocket.setTimeout(TIMEOUT, function() {
					console.log('ERROR: couldn\'t establish startup circuit (timeout before creation)');
					return shutdown();
				});
			});
			
		}

		// TODO: Change back to Tor61Router at the end
		regService.sendMessage(regService.fetch("Tor61Router-7777"), fetchedCallback);
	}
	
	setTimeout(function() {
		console.log('Beginning startup for router 0x' + routerName.toString(16));
		regService.sendMessage(regService.register(connectionSocket.address().port, routerName, registrationName), registeredCallback);
	}, 100);
}



var proxy = net.createServer(function(bSocket) {
	bSocket.on('error', function() {
		// TODO: error handling
	});

	bSocket.on('end', function() {
		streams.delete(bSocket);
	});

	bSocket.on('data', function(data) {
		if (streams.get(bSocket)) {
			if (data.length > 498) {
				console.log('Proxy: got browser packet too large for one Tor packet');
				return;
			}

			sourceSocket.write(relay(sourceCircuit, streams.get(bSocket), RELAY_DATA, data));
			return;
		}

		var headerIndex = data.indexOf('\n\r\n');
		if (headerIndex < 0) {
			console.log('Proxy: couldn\'t find end of header');
		}

		var header = data.toString('ascii', 0, headerIndex).trim();
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

		if (!port || !host) {
			console.log('Proxy: couldn\'t get host/port');
			return;
		}

		if (requestType.toLowerCase() === 'get' || requestType.toLowerCase() === 'post' ) {
			var path = uri.substring(uri.indexOf(host) + host.length);
			request = requestType + ' ' + path + ' HTTP/1.0';
		} else {
			request = request.replace(/HTTP\/\d+\.\d+/, 'HTTP/1.0');
		}
		headerLines[0] = request;

		var headerString = '';
		for (var i = 0; i < headerLines.length; i++) {
			headerString += (headerLines[i] + '\r\n');
		}
		headerString += '\r\n';
		var headerBuffer = Buffer.from(headerString, 'ascii');



		if (headerIndex + 3 > data.length) {
			console.log('Proxy: got HTTP request with a payload?');
			var payload = data.slice(headerIndex + 3);
		}
		
		sourceSocket.write(relay(sourceCircuit, streamCounter++, RELAY_BEGIN, Bufer.from(host + ':' + port + '\0', 'ascii')));

		// TODO: store header, wait for RELAY_CONNECTED, then send the header
		// TODO: timeout for RELAY_CONNECTED
	});
});


/**************************************
GOAL: one-hop tor cicuit with one router

1. Register with regservice.
2. Fetch from regservice.  We should get back only ourself (the source router).
3. Choose random next router (must be us).
4. Check connections: we shouldn't be there.  Start TCP and send CELL_OPEN.
5. Receive CELL_OPEN. Send back CELL_OPENED.
6. Receive CELL_OPENED. Tor connection X1 with self established.
	Because this is all on one router, we will store this connection twice:
	First on receiving OPEN, then on receiving OPENED.
7. Choose source circuit number c1 on X1.
8. Send CELL_CREATE with circuit number c1 on Tor connection X1.
	TODO: mantain state for circuit numbers for each connection?
9. Receive CELL_CREATE. Send back CELL_CREATED.
	Map (c1, self) to null.  Null means we are the last router in the circuit.
10. Receive CELL_CREATED.

(Skip relay steps for now.)

11. Browser connects on proxyport.  Parse HTTP.
12. Choose stream number s1 on c1.  Send RELAY_BEGIN to self through X1.
13. Receive RELAY_BEGIN.  Check routing table: (c1, self) maps to null.
14. Last router reached.  Open connection with google/cnn/whatever.
15. Send RELAY_CONNECTED back through s1 on c1.
16. Recieve RELAY_CONNECTED, send RELAY_DATA with GET request.
17. Recieve RELAY_DATA, send data payload to google/cnn/whatever.
15. Receive web page from google/cnn/whatever. Send page back using RELAY_DATA.
16. Receive page in RELAY_DATA, return payload to browser.

*/


