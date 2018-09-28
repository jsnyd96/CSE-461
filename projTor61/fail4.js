const net = require('net');
const regService = require('./RegistrationClient');
const readline = require('readline');
const ip = require('ip')

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
var streamSockets = new Map(); // Maps streams to browser sockets 

// Map for when we're the last router in a circuit and we need to decide which web server to send to
var browserStreams = new Map(); // Incoming socket -> circuit number -> stream number -> outgoing socket

var streamBuffers = new Map(); // Maps streams to buffers holding data to send while waiting for RELAY_CONNECTED

var headerBuffers = new Map(); // Incoming socket -> circuit number - > stream number -> (seen header flag, headerBuffer)

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
	cell.fill(body, 14, 14 + Buffer.byteLength(body), 'ascii');
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
	// sourceSocket.write(destroy(sourceCircuit));

	console.log('SHUTDOWN');
	// This calls process.exit
	regService.quit();

}

// TODO: Might want to remove this at the end
process.on('uncaughtException', function(err) {
	console.log("GLOBAL ERROR: " + err);
	console.log(err.stack);
	shutdown();
});

// Socket waiting for connections from other Tor61 routers
var connectionSocket = net.createServer(function(socket) {
	socket.on('data', function(data) {
	
		while (Buffer.byteLength(data) > 0) {

			// console.log("SERVER LOOPING, BYTES LEFT: " + Buffer.byteLength(data));
			var cellType = data.readUInt8(2);

			if (cellType === CELL_DESTROY) {
				//cleanup
			} else if (cellType === CELL_OPEN) {
				// Add new connection to connections
				console.log('Got OPEN!');
				var agentId = data.readUInt32BE(3);
				connections.set(agentId, socket);
				circuits.set(agentId, 2);
				socket.write(opened(agentId, routerName));
	
			} else if (cellType === CELL_CREATE) {
				console.log("Got CREATE!");
				var circuit = data.readUInt16BE(0);
				socket.write(created(circuit));
				if (!routingTable.has(socket)) {
					routingTable.set(socket, new Map());
				} 
				//routingTable.get(socket).set(circuit, null);

			} else if (cellType === CELL_CREATE_FAILED) {
				console.log("Got CREATE_FAIL");
				var circuit = data.readUInt16BE(0);
				var incoming = routingData.get(socket).get(circuit);

				incoming.socket.write(relay(incoming.circuit, 0, RELAY_EXTEND_FAILED, ""));
				//console.log("sent extend fail");

				routingData.delete(inSocket);
				routingData.delete(socket);

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
				var body = data.slice(14, 14 + data.readUInt16BE(11));

				console.log("Got RELAY " + relayType);

				if (relayType === RELAY_BEGIN) {
					var nextRouter = routingTable.get(socket).get(circuit);
					//console.log("Begin with circuit " + circuit);
					if (!nextRouter) {
						// We're the last router in the circuit - create a connection with the requested web server
						body = body.toString('ascii');
						var host = body.substring(0, body.indexOf(":"));
						var port = body.substring(body.indexOf(":") + 1, body.indexOf("\0"));
						var sSocket = new net.Socket();

						sSocket.on('error', function(err) {
							console.log("Error connecting to " + host + ":" + port);
							console.log(err.message + "\n");
							socket.write(relay(circuit, stream, RELAY_BEGIN_FAILED, ""));
						});

						var serverSocket = sSocket;
						var inSocket = socket;
						sSocket.connect(port, host, function() {
							console.log("Connected to web server " + host);
							if (!headerBuffers.has(socket)) {
								headerBuffers.set(socket, new Map());
							}
							if (!headerBuffers.get(socket).has(circuit)) {
								headerBuffers.get(socket).set(circuit, new Map());
							}

							if (port !== '443') {
								headerBuffers.get(socket).get(circuit).set(stream, null);
							} else {
								console.log('Got CONNECT');
							}

							inSocket.write(relay(circuit, stream, RELAY_CONNECTED, ""));
							serverSocket.on('data', function(sData) {
								// streamSockets.get(stream).write(sData);

								// console.log("Response:");
								// console.log(sData.toString('ascii'));

								// 498 is the max size of the body
								// If the data is smaller than 498, slice will still work properly

								// @ANDY
								// TODO: fix other sockets so they handle multiple tor packets
								while(Buffer.byteLength(sData) > 0) {
									// console.log(Buffer.byteLength(sData));
									inSocket.write(relay(circuit, stream, RELAY_DATA, sData.slice(0, 498)));
									sData = sData.slice(498);

								}

							});
						});
						if (!browserStreams.has(inSocket)) {
							browserStreams.set(inSocket, new Map());
						}
						if (!browserStreams.get(inSocket).has(circuit)) {
							browserStreams.get(inSocket).set(circuit, new Map());
						}
						// Seems kind of ugly, making do with it at the moment
						browserStreams.get(inSocket).get(circuit).set(stream, serverSocket);
					} else {
					//	console.log("Forwarding begin");
						var begin = relay(nextRouter.circuit, stream, RELAY_BEGIN, body);
						nextRouter.socket.write(begin);
					}
				} else if (relayType === RELAY_DATA) {
					var nextRouter = routingTable.get(socket).get(circuit);
					if (!nextRouter) {
						//console.log("writing to server");
						//console.log(body);
						//console.log("Writing to server for stream " + stream);
						//console.log("BODY SIZE: " + Buffer.byteLength(data));
						//console.log("BODY: " + body.toString('ascii'));

						if (!headerBuffers.get(socket).get(circuit).has(stream)) {
							browserStreams.get(socket).get(circuit).get(stream).write(body);
							data = data.slice(512);
							continue;
						}
						var headerBuffer = headerBuffers.get(socket).get(circuit).get(stream);

						if (headerBuffer) {
							headerBuffer = Buffer.concat([headerBuffer, body]);
						} else {
							headerBuffer = body;
						}

						var headerIndex = headerBuffer.indexOf('\n\r\n');
						if (headerIndex < 0) {
							headerBuffers.get(socket).get(circuit).set(stream, headerBuffer);
							console.log("Current header: ");
							console.log(headerBuffer.toString('ascii'));
							data = data.slice(512);
							continue;	
						}
						headerBuffers.get(socket).get(circuit).delete(stream);
						console.log("Request byte length: " + Buffer.byteLength(headerBuffer));
						console.log(headerBuffer.toString('ascii'));
						browserStreams.get(socket).get(circuit).get(stream).write(headerBuffer.toString('ascii'));
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
				} else if (relayType === RELAY_EXTEND) {
					body = body.toString('ascii');
					extend(socket, circuit, body);
				} else if (relayType === RELAY_EXTENDED) {
					var nextRouter = routingTable.get(socket).get(circuit);
					var extended = relay(nextRouter.circuit, stream, RELAY_EXTENDED, body);
					nextRouter.socket.write(extended);
				} else {
					// Bad Relay
					console.log("ERROR: Bad relay " + relayType);
					shutdown();
				}
			} else {
				// Bad cell
				console.log("ERROR: Bad cell");
				console.log(cellType);
				shutdown();
			}

			data = data.slice(512);
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
			startup(entries);
		}

		// TODO: Change back to Tor61Router at the end
		regService.sendMessage(regService.fetch("Tor61Router-7777"), fetchedCallback);
	}
	
	setTimeout(function() {
		console.log('Beginning startup for router 0x' + routerName.toString(16));
		regService.sendMessage(regService.register(connectionSocket.address().port, routerName, registrationName), registeredCallback);
	}, 100);
}



function startup(entries) {
	// entries is a list of available routers
	// Routers are removed on relay extend fails
	// If entries empty, quit
	var entryIndex = Math.floor(Math.random() * entries.length);
	var entry = entries[entryIndex];
	
	var timer;
	var startupState = 0;
	// 0: waiting for opened
	// 1: waiting for created
	// 2: waiting for relay extended 1
	// 3: waiting for relay extended 2
	// 4: done

	var cSocket = new net.Socket();
	var circuitSocket = cSocket;
	sourceSocket = circuitSocket;
	cSocket.connect(entry.entryPort, ip.fromLong(entry.entryIp), function() {
		circuitSocket.on('data', function(responseData) {
			while (Buffer.byteLength(responseData) > 0) {

				var cellType = responseData.readUInt8(2);

				// Disable opened timeout
				circuitSocket.setTimeout(0);
				// Relay timeout flag
				var relayTimeout = false;

				var circuit = responseData.readUInt16BE(0);

				if (startupState === 0 && cellType === CELL_OPENED) {
					console.log("Creating circuit 1 with router 0x" + entry.entryData.toString(16));

					if (entry.entryData != routerName) {
						connections.set(entry.entryData, circuitSocket);
					}

					circuits.set(entry.entryData, 3);
					circuitSocket.write(create(1));
					circuitSocket.setTimeout(TIMEOUT);
					startupState++;
					responseData = responseData.slice(512);
					continue;

				} else if (startupState === 0 && cellType === CELL_OPEN_FAILED) {
					console.log('ERROR: couldn\'t establish startup circuit (open failed)');
					return shutdown();

				} else if (startupState === 1 && cellType === CELL_CREATE_FAILED) {
					console.log('ERROR: couldn\'t establish startup circuit (create failed)');
					return shutdown();

				} else if (startupState === 1 && cellType === CELL_CREATED) {

					sourceCircuit = circuit;
				
					entryIndex = Math.floor(Math.random() * entries.length);
					entry = entries[entryIndex];

					console.log("First extend for circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
					circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));
					startupState++;
					if (!routingTable.has(circuitSocket)) {
						routingTable.set(circuitSocket, new Map());
					}
	
					// set relay timeout
					relayTimeout = true;

				} else if (startupState < 4 && cellType === CELL_RELAY) {

					var relayType = responseData.readUInt8(13);
					var circuit = responseData.readUInt16BE(0);
					var body = responseData.slice(14, 14 + responseData.readUInt16BE(11)).toString('ascii');

					if (relayType === RELAY_EXTENDED) {
						clearTimeout(timer);
						startupState++;

						if (startupState < 4) {
							entryIndex = Math.floor(Math.random() * entries.length);
							entry = entries[entryIndex];
							console.log("Extending circuit " + circuit + " with router 0x" + entry.entryData.toString(16));
							circuitSocket.write(relay(circuit, 0, RELAY_EXTEND, entry.entryIp + ":" + entry.entryPort + '\0' + entry.entryData));

							// set relay timeout
							relayTimeout = true;
						} else {
							startProxy();
							console.log("Creation of startup circuit " + circuit + " finished\n");
							console.log("HTTP proxy is up on port " + proxyPort);
							console.log("Tor61 router is up on port " + connectionSocket.address().port + "\n");

						}

					} else if (relayType === RELAY_EXTEND_FAILED) {
						clearTimeout(timer);
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

						// set relay timeout
						relayTimeout = true;
	
					} else if (relayType === RELAY_EXTEND) {
						extend(circuitSocket, circuit, body)
	
					} else {
						console.log('startup got relay type ' + relayType);
					}

				} else if (startupState < 4 && cellType === CELL_CREATE) {
					var createdCircuit = responseData.readUInt16BE(0);
					circuitSocket.write(created(createdCircuit));
					if (!routingTable.has(circuitSocket)) {
						routingTable.set(circuitSocket, new Map());
					}

				} else if (startupState === 4) {
					if (cellType === CELL_CREATED) {
						// Same as server socket

						var incoming = routingData.get(circuitSocket).get(circuit);

						var inCircuit = incoming.circuit;
						var inSocket = incoming.socket;
	
						if (!routingTable.has(circuitSocket)) {
							routingTable.set(circuitSocket, new Map());
						}
	
						routingTable.get(inSocket).set(inCircuit, {'circuit' : circuit, 'socket' : circuitSocket});
						routingTable.get(circuitSocket).set(circuit, {'circuit' : inCircuit, 'socket' : inSocket});
						routingData.delete(inSocket);
						routingData.delete(circuitSocket);

						inSocket.write(relay(inCircuit, 0, RELAY_EXTENDED, ""));

					} else if (cellType === CELL_RELAY) {

						var relayType = responseData.readUInt8(13);
						var body = responseData.slice(14, 14 + responseData.readUInt16BE(11));
						var prevRouter = routingTable.get(circuitSocket).get(circuit);
						var stream = responseData.readUInt16BE(3);

						if (relayType === RELAY_BEGIN) {
							prevRouter.socket.write(relay(prevRouter.circuit, stream, RELAY_BEGIN, body));
						} else if (relayType === RELAY_DATA) {
							if (prevRouter) {
								prevRouter.socket.write(relay(prevRouter.circuit, stream, RELAY_DATA, body));
							} else {
								// Write back to browser
						//		console.log("Writing back to browser");
						//		console.log("startup data size: " + Buffer.byteLength(responseData));
								streamSockets.get(stream).write(body);
							}
						} else if (relayType === RELAY_EXTEND) {
							body = body.toString('ascii');
							extend(circuitSocket, circuit, body);
						} else if (relayType === RELAY_EXTEND_FAILED) {
							prevRouter.socket.write(relay(prevRouter.circuit, stream, RELAY_EXTEND_FAILED, ""));
						} else if (relayType === RELAY_EXTENDED) {
							prevRouter.socket.write(relay(prevRouter.circuit, stream, RELAY_EXTENDED, ""));
						} else if (relayType === RELAY_CONNECTED) {
							if (prevRouter) {
								prevRouter.socket.write(relay(prevRouter.circuit, stream, RELAY_CONNECTED, ""));
							} else {
								var buffer = streamBuffers.get(stream);
								if (buffer.toString('ascii').toLowerCase().startsWith('connect')) {
									streamSockets.get(stream).write("HTTP/1.0 200 OK\r\n\r\n");
								} else {
									while(Buffer.byteLength(buffer) > 0) {
										var msg = relay(circuit, stream, RELAY_DATA, buffer.slice(0, 498));
										circuitSocket.write(msg); 
										buffer = buffer.slice(498);
										console.log("START UP SENDING MSG, " + Buffer.byteLength(buffer) + " BYTES LEFT");
									}
								}
							}
						}
	
					} else if (cellType === CELL_CREATE) {
						var createdCircuit = data.readUInt16BE(0);
						circuitSocket.write(created(createdCircuit));
						if (!routingTable.has(circuitSocket)) {
							routingTable.set(circuitSocket, new Map());
						} 
					} else {
						console.log('?????');
					}
				} else {
					console.log('startup got cell type ' + cellType);
				}

				if (relayTimeout) {
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
				}
				responseData = responseData.slice(512);
			}
		});


		console.log("Sending open to router 0x" + entry.entryData.toString(16));
		circuitSocket.write(open(routerName, entry.entryData));

		circuitSocket.setTimeout(TIMEOUT, function() {
			console.log('ERROR: couldn\'t establish startup circuit (timeout before creation)');
			return shutdown();
		});
	});
}


function extend(socket, circuit, body) {
	console.log('extending...');
	var nextRouter = routingTable.get(socket).get(circuit);
	if (nextRouter) {
		nextRouter.socket.write(relay(nextRouter.circuit, 0, RELAY_EXTEND, body));
		return;
	}

	var ip = body.substring(0, body.indexOf(":"));
	var port = parseInt(body.substring(body.indexOf(":") + 1, body.indexOf("\0")));
	var agentId = parseInt(body.substring(body.indexOf("\0") + 1));

	if (connections.has(agentId)) {

		// we don't have to do anything if we are extending to ourself
		if (agentId == routerName) {
			socket.write(relay(circuit, 0, RELAY_EXTENDED, ""));
			return;
		}

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
			circuitSocket.on('data', function(data) {
				while (Buffer.byteLength(data) > 0) {
	
					var cellType = data.readUInt8(2);

					if (cellType === CELL_OPENED) {
						console.log("Inner socket got OPENED");

						var openedId = data.readUInt32BE(7);

						connections.set(openedId, circuitSocket);
						circuits.set(openedId, 3);

						circuitSocket.write(create(1));
					} else if (cellType === CELL_CREATED) {
						console.log("Inner socket got CREATED");
	

						routingTable.get(inSocket).set(inCircuit, {'circuit' : 1, 'socket' : circuitSocket});
						if (!routingTable.has(circuitSocket)) {
							routingTable.set(circuitSocket, new Map());
						}
	
						routingTable.get(circuitSocket).set(1, {'circuit' : inCircuit, 'socket' : inSocket});

						inSocket.write(relay(inCircuit, 0, RELAY_EXTENDED, ""));

					} else if (cellType === CELL_RELAY) {

						var relayType = data.readUInt8(13);
						var innerCircuit = data.readUInt16BE(0);
						var innerBody = data.slice(14, 14 + data.readUInt16BE(11));
	
						console.log('Inner socket got relay ' + relayType);

						if (relayType === RELAY_BEGIN) {
							socket.write(relay(circuit, data.readUInt16BE(3), RELAY_BEGIN, innerBody));
						} else if (relayType === RELAY_DATA) {
							socket.write(relay(circuit, data.readUInt16BE(3), RELAY_DATA, innerBody));
						} else if (relayType === RELAY_EXTEND) {
							innerBody = innerBody.toString('ascii');
							extend(circuitSocket, innerCircuit, innerBody);
						} else if (relayType === RELAY_EXTEND_FAILED) {
							socket.write(relay(circuit, data.readUInt16BE(3), RELAY_EXTEND_FAILED, ""));
						} else if (relayType === RELAY_EXTENDED) {
							socket.write(relay(circuit, data.readUInt16BE(3), RELAY_EXTENDED, ""));
						} else if (relayType === RELAY_CONNECTED) {
							socket.write(relay(circuit, data.readUInt16BE(3), RELAY_CONNECTED, ""));
						}

					} else if (cellType === CELL_CREATE) {
						var createdCircuit = data.readUInt16BE(0);
						circuitSocket.write(created(createdCircuit));
						if (!routingTable.has(circuitSocket)) {
							routingTable.set(circuitSocket, new Map());
						} 
					} else {
						console.log("Inner socket got cell type " + cellType);
					}
					data = data.slice(512);
				}
			});

			// send CREATE on success, send back RELAY_EXTEND_FAIL on fail
			circuitSocket.write(open(routerName, agentId));
		}); 
	}
}


function startProxy() {
	// TODO: @John - Main problem right now seems to be that the request getting sent to the server is invalid (HTTP 400 is the response back), might be because of errors in how the request is encoded or how it's edited here

	var proxy = net.createServer(function(bSocket) {
		bSocket.on('error', function() {
			// TODO: error handling
		});

		bSocket.on('end', function() {
			streams.delete(bSocket);
		});
	
		bSocket.on('data', function(data) {
			//console.log("Got request: ");
			//console.log(data.toString('ascii'));
			if (streams.get(bSocket)) {
				console.log("More data from stream " + streams.get(bSocket));
				//console.log(data.toString('ascii'));

				if (Buffer.byteLength(data) > 498) {
					// console.log('too much data');
				}

				while(Buffer.byteLength(data) > 0) {
					sourceSocket.write(relay(sourceCircuit, streams.get(bSocket), RELAY_DATA, data.slice(0, 498)));
					data = data.slice(498);
				}

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
			
			// TODO: Remove at the end
			var blocked = ['firefox', 'mozilla'];
			for (var i = 0; i < blocked.length; i++) {
				if (uri.includes(blocked[i])) {
					return;
				}
			}

			console.log("BEFORE CUT: " + Buffer.byteLength(data) + " BYTES");

			console.log("Got request: ");
			console.log(data.toString('ascii'));

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


			var payload = data.slice(headerIndex + 3);
			if (headerIndex + 3 > data.length) {
				console.log('Proxy: got HTTP request with a payload?');
				payload = data.slice(headerIndex + 3);
			}
			console.log("AFTER CUT: " + Buffer.byteLength(headerBuffer) + " BYTES");

			//console.log("Stream " + streamCounter + ":\n" + headerString);
			streams.set(bSocket, streamCounter);
			streamSockets.set(streamCounter, bSocket);
			console.log("Edited request: ");
			console.log(headerBuffer.toString('ascii'));
			streamBuffers.set(streamCounter, Buffer.concat([headerBuffer, payload]));
			sourceSocket.write(relay(sourceCircuit, streamCounter, RELAY_BEGIN, host + ':' + port + '\0'));
			// Stream ID is only 2 bytes long
			if (streamCounter === 0xffff) {
				streamCounter = 0;
			} else {
				streamCounter++;
			}

			// TODO: store header, wait for RELAY_CONNECTED, then send the header
			// TODO: timeout for RELAY_CONNECTED
		});
	}).listen(proxyPort);
}




