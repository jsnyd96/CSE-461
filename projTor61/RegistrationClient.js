const dgram = require('dgram');
const dns = require('dns');
const ip = require('ip');
const readline = require('readline');

const requestSocket = dgram.createSocket('udp4');
const probeSocket = dgram.createSocket('udp4');

requestSocket.bind(0, function() {
	probeSocket.bind(requestSocket.address().port + 1, function() {
		console.log("Registration agent listening on " + requestSocket.address().port +
				", " + probeSocket.address().port +"\n");
		startAgent();
	});
});

var serviceHost = "cse461.cs.washington.edu";
var servicePort = 46101;
var seqNum = 0;  // first message sent has seqNum = 0

const AGENT_IP = ip.address();
const MAGIC = 0xC461;
const MSG_REGISTER = 0x01;
const MSG_REGISTERED = 0x02;
const MSG_FETCH = 0x03;
const MSG_FETCH_RESPONSE = 0x04;
const MSG_UNREGISTER = 0x05;
const MSG_PROBE = 0x06;
const MSG_ACK = 0x07;
const TIMEOUT = 1000;

var registrations = {}; // Maps ports to refresh timers
var timer;		// For resending requests after timeout
var attempts;		// Each request tries 3 sends before failing
var lastRequest;	// Current outstanding request
var lastMessage;	// Current outstanding message
var reqCallback;	// App callback function
var refreshCallback = function() {};	// App callback on re-register

// Attempt each send 3 times in case of network errors
function timeout(message) {
	console.log("Timed out waiting for reply to " + lastRequest + " message");
	if (attempts < 3) {
		requestSocket.send(message, servicePort, serviceHost);
		attempts++;
		timer = setTimeout(timeout, TIMEOUT, message);
	} else {
		console.log("Sent 3 " + lastRequest + " messages but got no reply.");
		reqCallback(true);
	}
}

// Send the given request with the given message, calling callback upon failure/success
function sendMessage(message, callback) {
	var msgType = message.readUInt8(3);

	switch(msgType) {
		case MSG_REGISTER:
			lastRequest = "REGISTER";
			break;
		case MSG_FETCH:
			lastRequest = "FETCH";
			break;
		case MSG_UNREGISTER:
			lastRequest = "UNREGISTER";
			break;
		case MSG_PROBE:
			lastRequest = "PROBE";
			break;
		default:
			return;
	}

	lastMessage = message;
	reqCallback = callback;
	// console.log("Sending " + lastRequest + "[" + seqNum + "]...");
	requestSocket.send(message, servicePort, serviceHost);
	attempts = 1;
	timer = setTimeout(timeout, TIMEOUT, message);

	seqNum++;
	if (seqNum > 255) seqNum = 0;
}

// Setup for all event listeners
function startAgent() {
	requestSocket.on('message', function(msg, rinfo) {
		responseMagic = msg.readUInt16BE(0);
		responseSeqNum = msg.readUInt8(2);
		responseMsgType = msg.readUInt8(3);

		if (responseMagic != MAGIC) {
			console.log('Error: Received bad magic from server');
			reqCallback(true);
			return;
		}

		if (responseSeqNum != lastMessage.readUInt8(2)) {
			console.log('Error: Incorrect sequence number from server');
			console.log('Got ' + responseSeqNum + ' instead');
			reqCallback(true);
			return;
		}

		clearTimeout(timer);

		if (lastRequest === "REGISTER" && responseMsgType === MSG_REGISTERED) {
			responseLifetime = msg.readUInt16BE(4);
			// console.log("Register successful! Lifetime = " + responseLifetime);
			
			var port = lastMessage.readUInt16BE(8);
			var data = lastMessage.readUInt32BE(10);
			var name = lastMessage.toString('utf8', 15);

			registrations[port] = setTimeout(function(port, data, name) {
				sendMessage(register(port, data, name), refreshCallback);
			}, responseLifetime * 1000, port, data, name);

			reqCallback(false);
		} else if (lastRequest === "FETCH" && responseMsgType === MSG_FETCH_RESPONSE) {
			numEntries = msg.readUInt8(4);
			entries = []
			for (var i = 0; i < numEntries; i++) {
				// Each entry takes up 10 bytes and the first one starts at pos 5
				startingPos = 5 + (i * 10); 
				entry = {
					entryIp: msg.readUInt32BE(startingPos),
					entryPort: msg.readUInt16BE(startingPos + 4),
					entryData: msg.readUInt32BE(startingPos + 4 + 2)
				}
				entries.push(entry);
			}
			
			reqCallback(false, entries);
		} else if (lastRequest === "UNREGISTER" && responseMsgType === MSG_ACK) {
			var port = lastMessage.readUInt16BE(8);
			clearTimeout(registrations[port]);
			delete registrations[port];
			console.log('Unregistered port ' + port + '.');

			reqCallback(false);
		} else if (lastRequest === "PROBE" && responseMsgType == MSG_ACK) {
			console.log('Probe success!');
			reqCallback(false);
		} else {
			console.log('Error: Incorrect response type from server');
			return;
		}

	});

	probeSocket.on('message', function(msg, rinfo) {
		responseMagic = msg.readUInt16BE(0);
		responseSeqNum = msg.readUInt8(2);
		responseMsgType = msg.readUInt8(3);
		if (responseMagic === 0xC461 && responseMsgType == MSG_PROBE) {
			console.log('Probe received. Sending ACK.');
			var message = Buffer.alloc(4);
			message.writeUInt16BE(MAGIC, 0);
			message.writeUInt8(responseSeqNum, 2);
			message.writeUInt8(MSG_ACK, 3);
			probeSocket.send(message, rinfo.port, rinfo.address);
		}
		//options();
	});
}

function register(port, data, name) {
	var message = Buffer.alloc(15 + name.length);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_REGISTER, 3);
	message.writeUInt32BE(ip.toLong(AGENT_IP), 4);
	message.writeUInt16BE(port, 8);
	message.writeUInt32BE(data, 10);
	message.writeUInt8(name.length, 14);
	message.write(name, 15);
	return message;
}

function unregister(port) {
	var message = Buffer.alloc(10);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_UNREGISTER, 3);
	message.writeUInt32BE(ip.toLong(AGENT_IP), 4);
	message.writeUInt16BE(port, 8);
	return message;
}

function fetch(name) {
	bufSize = 5;
	// Have to dynamically allocate buffer here because name is optional
	nameLength = 0;
	if (name !== null) {
		nameLength = name.length;
	}
	var message = Buffer.alloc(bufSize + nameLength);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_FETCH, 3);
	message.writeUInt8(nameLength, 4);
	if (name !== null) {
		message.write(name, 5);
	}
	return message;
}

function probe() {
	var message = Buffer.alloc(4);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_PROBE, 3);
	return message;
}

// Close the registration agent
function quit() {
	// Unregister all ports
	var wait = 0;
	Object.keys(registrations).forEach(function(port) {
		setTimeout(function() {
			sendMessage(unregister(port), function() {});
		}, wait);
		wait += 100;
	});


	setTimeout(function() {
		requestSocket.close(function() {
			probeSocket.close(process.exit);
		});
	}, wait + 200);
}

// Print usage instructions
function options() {
	console.log("");
	console.log("Enter a command:");
	console.log("  Register   - r <portnum> <data> <seviceName>");
	console.log("  Unregister - u <portnum>");
	console.log("  Fetch      - f <prefix>");
	console.log("  Probe      - p");
	console.log("  Quit       - q");
}

function setRefresh(callback) {
	refreshCallback = callback;
}

if (require.main === module) {
	if (process.argv.length !== 4) {
		console.log('Usage: ./run <service hostname> <service port>');
		process.exit();
	}

	serviceHost = process.argv[2];
	servicePort = parseInt(process.argv[3]);

	dns.lookup(serviceHost, 4, function(err, address, family) {
		console.log("Server IP: " + address);
		console.log("Agent IP: " + AGENT_IP);
		options();
	});
	

	const rl = readline.createInterface({
		input: process.stdin,
	        output: process.stdout
	});


	function callback(err) {
		options();
	}

	setRefresh(callback);

	function fetchCallback(err, entries) {
		if (!err) {
			entries.forEach(function(item) {
				console.log(ip.fromLong(item.entryIp) + " " + 
						item.entryPort + " " +
						item.entryData + " (0x" + 
						item.entryData.toString(16) + ")");
			});
		}
		options();
	}

	rl.on('line', function(line) {
		if (line === "q") {
			quit();
		} else if (line.startsWith("r ")) {
			var args = line.split(" ");
			if (args.length == 4) {
				sendMessage(register(args[1], args[2], args[3]), callback);
			}
		} else if (line.startsWith("u ")) {
			var args = line.split(" ");
			if (args.length == 2) {
				sendMessage(unregister(args[1]), callback);
			}
		} else if (line.startsWith("f")) {
			var args = line.split(" ");
			if (args.length === 1) {
				sendMessage(fetch(null), fetchCallback);
			} else if (args.length === 2) {
				sendMessage(fetch(args[1]), fetchCallback);
			}
		} else if (line === "p") {
			sendMessage(probe(), callback);
		} else {
			options();
		}
	});

	rl.on('close', function() {
		console.log("eof");
		quit();
	});
}

module.exports = {
	sendMessage: sendMessage,
	register: register,
	unregister: unregister,
	fetch: fetch,
	probe: probe,
	quit: quit,
	setRefresh: setRefresh
};


