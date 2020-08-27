#!/usr/bin/env node
(()=>{
	"use strict";
	
	const GenInstId = require('./helper/gen-inst-id.js');
	const term = require('./helper/term-code.js');
	const net = require('net');
	
	
	
	const config = { host: '127.0.0.1', port: 65500, debug:false };
	{
		const argv = process.argv.slice(2);
		while( argv.length > 0 ) {
			const option = argv.pop();
			const [arg, assign] = __CMD_SPLIT(option);
			switch(arg) {
				case "--host":
				case "-H":
					config.host = assign||config.host;
					break;
					
				case "--port":
				case "-p":
					config.port = (assign||config.port)|0;
					break;
					
				case "--debug":
					config.debug = true;
					break;
				
				default:
					break;
			}
		}
		function __CMD_SPLIT(option) {
			option = ('' + (option||'')).trim();
		
			const index = option.indexOf('=');
			return index>0?[
				option.substring(0, index), option.substring(index+1)
			]:[option, ""];
		}
	}
	
	
	
	
	const {host, port, debug} = config;
	const ZERO_BUFFER = Buffer.alloc(0);
	const MSG_TYPE = {
		HELO: 0x01,
		CALL: 0x02,
		CALL_SUCC: 0x03,
		CALL_FAIL: 0x04,
		EVNT: 0x05,
		ACK:  0xFF
	};
	const PRIVATE = new WeakMap();
	const ROOM = new Map();
	const SERVER_STATE = {
		timeout: null,
		queue: []
	};
	
	
	class BufferReader {
		/** @type {Buffer} **/
		#buffer = null;
		#offset = 0;
		constructor(buffer=null, offset=0) {
			if ( buffer === null ) {
				this.#buffer = Buffer.alloc(0);
				this.#offset = 0;
				return;
			}
			
			this.#buffer = buffer;
			this.#offset = offset;
		}
		bindBuffer(buffer, offset=0) {
			this.#offset = offset;
			this.#buffer = buffer;
		}
		readUInt8() {
			const shift = this.#offset+1;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.readUInt8(this.#offset);
			this.#offset = shift;
			return value;
		}
		readUInt16LE() {
			const shift = this.#offset+2;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.readUInt16LE(this.#offset);
			this.#offset = shift;
			return value;
		}
		readUInt32LE() {
			const shift = this.#offset+4;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.readUInt32LE(this.#offset);
			this.#offset = shift;
			return value;
		}
		readFloat32LE() {
			const shift = this.#offset+4;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.readFloatLE(this.#offset);
			this.#offset = shift;
			return value;
		}
		readFloat64LE() {
			const shift = this.#offset+8;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.readDoubleLE(this.#offset);
			this.#offset = shift;
			return value;
		}
		readBytes(length) {
			const shift = this.#offset+length;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.slice(this.#offset, shift);
			this.#offset = shift;
			return value;
		}
		readUTF8String(length) {
			const shift = this.#offset+length;
			if ( this.#buffer.length < shift ) return null;
			
			const value = this.#buffer.toString('utf8', this.#offset, shift);
			this.#offset = shift;
			return value;
		}
		
		get offset() { return this.#offset; }
	}
	
	
	
	
	net.createServer((conn)=>{
		const client = Object.create(null);
		PRIVATE.set(conn, client);
		
		client.id		= GenInstId();
		client.valid	= true;
		client.state	= 0;
		client.chunk	= ZERO_BUFFER;
		client.timeout	= setTimeout(()=>client.socket.end(), 5000);
		client.room_id	= '';
		client.room		= null;
		client.socket	= conn
		.on('data',	 _ON_CLIENT_DATA)
		.on('error', _ON_CLIENT_ERROR)
		.on('end',	 _ON_CLIENT_END);
	})
	.on('error', (e)=>{
		console.error(`Unexpected server error! ${e.message}`);
	})
	.listen(port, host, ()=>{
		console.log(`${term.YELLOW}Server is now listening on ${term.LIGHT_GREEN}${host}${term.YELLOW}:${term.LIGHT_GREEN}${port}${term.YELLOW}...${term.RESET}\n`);
	});
	
	
	
	
	function ___EAT_HELO_MSG(client) {
		const data_chunk = client.chunk;
		const reader = new BufferReader(data_chunk);
		const cmd = reader.readUInt8();
		if ( cmd === null ) return null;
		if ( cmd !== MSG_TYPE.HELO ) return false;
		
		
		
		// 0x01 + uint16 + bytes{0,}
		let len = reader.readUInt16LE();
		if ( len === null ) return null;
		
		const channel_id = reader.readUTF8String(len);
		if ( channel_id === null ) return null;
		
		client.chunk = data_chunk.slice(reader.offset);
		return channel_id;
	}
	function _PARSE_CLIENT_DATA() {
		SERVER_STATE.timeout = null;
	
		const clients = Array.from(new Set(SERVER_STATE.queue.splice(0)));
		for(const client of clients) {
			if ( !client.valid ) continue;
			
			
			if ( client.state === 0 ) {
				const channel_id = ___EAT_HELO_MSG(client);
				if ( channel_id === false ) {
					clearTimeout(client.timeout);
					client.socket.end();
					continue;
				}
				
				
				
				if ( channel_id ) {
					clearTimeout(client.timeout);
				
					client.state = 1;
					let room = ROOM.get(channel_id);
					if ( !room ) {
						room = {A:client, B:null};
						ROOM.set(channel_id, room);
					}
					else
					if ( room.A === null ) {
						room.A = client;
					}
					else
					if ( room.B === null ) {
						room.B = client;
					}
					else {
						room.B.socket.end();
						room.B = client;
					}
					
					client.room_id = channel_id;
					client.room = room;
					client.socket.write(Buffer.from([0x01]));
					console.log(`[${GetLocalISOString()}] STAT, ${client.id}, channel:${client.room_id}`);
				}
				
				SERVER_STATE.queue.push(client);
				if ( !SERVER_STATE.timeout ) {
					SERVER_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
				}
				
				continue;
			}
			if ( client.chunk.length === 0) continue;
			
			
			const {room} = client;
			const paired_client = (room.A===client)?room.B:room.A;
			if ( !paired_client ) {
				SERVER_STATE.queue.push(client);
				if ( !SERVER_STATE.timeout ) {
					SERVER_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
				}
				continue;
			}
			
			
			if ( debug ) {
				console.log(`[${GetLocalISOString()}] DATA, ${client.id}, data:${client.chunk.toString('hex')}`);
			}
			paired_client.socket.write(client.chunk);
			client.chunk = ZERO_BUFFER;
		}
	}
	function _ON_CLIENT_DATA(chunk) {
		const client = PRIVATE.get(this);
		client.chunk = Buffer.concat([client.chunk, chunk]);
		
		SERVER_STATE.queue.push(client);
		if ( !SERVER_STATE.timeout ) {
			SERVER_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
		}
	}
	function _ON_CLIENT_ERROR(e) {
		const client = PRIVATE.get(this);
		client.valid = false;
		console.log(`[${GetLocalISOString()}] ERROR, ${client.id}, channel:${client.room_id||'-'}, error:${e.message}!`, e);
		
		const {room} = client;
		if ( !room ) return;
		
		
		if ( room.A === client ) {
			room.A = null;
		}
		else
		if ( room.B === client ) {
			room.B = null;
		}
	}
	function _ON_CLIENT_END(e) {
		const client = PRIVATE.get(this);
		client.valid = false;
		console.log(`[${GetLocalISOString()}] CLOS, ${client.id}, channel:${client.room_id||'-'}`);
		
		const {room} = client;
		if ( !room ) return;
		
		
		if ( room.A === client ) {
			room.A = null;
		}
		else
		if ( room.B === client ) {
			room.B = null;
		}
	}
	
	
	
	
	
	
	function GetLocalISOString() {
		const now = new Date();
		let offset, zone = now.getTimezoneOffset();
		if ( zone === 0 ) {
			offset = 'Z';
		}
		else {
			const sign = zone > 0 ? '-' : '+';
			zone = Math.abs(zone);
			const zone_hour = Math.floor(zone/60);
			const zone_min  = zone%60;
	
			offset = sign + Padding(zone_hour) + Padding(zone_min);
		}
	
	
	
		return  now.getFullYear() +
			'-' + Padding(now.getMonth()+1) +
			'-' + Padding(now.getDate()) +
			'T' + Padding(now.getHours()) +
			':' + Padding(now.getMinutes()) +
			':' + Padding(now.getSeconds()) +
			'.' + Padding(now.getMilliseconds() % 1000, 3, true) +
			offset;
	}
	function Padding(val, length=2, back=false){
		val = `${val}`;
		const remain = length - val.length;
		const stuffing = '0'.repeat(remain);
		return back ? val + stuffing : stuffing + val;
	}
})();
