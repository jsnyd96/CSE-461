const net = require('net');
const regService = require('./RegistrationClient');
const readline = require('readline');


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
	console.log('SHUTDOWN');
	// This calls process.exit
	regService.quit();

}

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




		}




	}

	// TODO: Change back to Tor61Router at the end
		regService.sendMessage(regService.fetch("Tor61Router-7777"), fetchedCallback);
	}
	
	setTimeout(function() {
		console.log('Beginning startup for router 0x' + routerName.toString(16));
		regService.sendMessage(regService.register(connectionSocket.address().port, routerName, registrationName), registeredCallback);
	}, 100);
}



