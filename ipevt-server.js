#!/usr/bin/env node
(()=>{
	"use strict";
	
	const ByteReader = require('./helper/byte-reader.js');
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
	
	
	
	
	net.createServer((conn)=>{
		const client = Object.create(null);
		PRIVATE.set(conn, client);
		
		client.id		= GenInstId();
		client.valid	= true;
		client.state	= 0;
		client.chunk	= ZERO_BUFFER;
		client.cache	= [];
		client.cache_size = 0;
		client.timeout	= setTimeout(()=>client.socket.end(), 5000);
		client.room_id	= '';
		client.room		= null;
		client.rslot	= '';
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
	
	
	
	
	function ___EAT_SEGMENT(client) {
		if ( client.chunk.length < 3 ) return false;
		
		const reader = new ByteReader(client.chunk, 0);
		
		reader.readUInt8(); reader.readUInt8();
		const length  = reader.readUInt8();
		const segment = reader.readBytes(length);
		if ( segment === null ) return false;
		
		
		const fragment = client.chunk.slice(0, reader.offset);
		client.chunk = client.chunk.slice(reader.offset);
		
		return fragment;
	}
	function ___EAT_HELO_MSG(data_chunk) {
		if ( data_chunk.length < 6 ) return null;
		
		const control_bits	= data_chunk.readUInt8(0);
		const is_fin_seg	= ((control_bits & 0x80) === 0);
		const command		= data_chunk.readUInt8(3);
		
		if ( !is_fin_seg || command !== MSG_TYPE.HELO ) return null;
		
		
		
		// 0x01 + uint16 + bytes{0,}
		const len = data_chunk.readUInt16LE(4);
		
		
		if ( data_chunk.length < (6+len) ) return null;
		
		return data_chunk.slice(6).toString('utf8');
	}
	function _PARSE_CLIENT_DATA() {
		SERVER_STATE.timeout = null;
	
		const clients = Array.from(new Set(SERVER_STATE.queue.splice(0)));
		for(const client of clients) {
			if ( !client.valid ) continue;
			
			while(client.chunk.length>0) {
				const segment = ___EAT_SEGMENT(client);
				if ( !segment ) break;
				
				
				
				const IS_FIN_SEGMENT = (segment[0]&0x80)===0;
				const SEGMENT_ID = Padding(segment[1].toString(16), 2);
				if ( client.state === 0 ) {
					const channel_id = ___EAT_HELO_MSG(segment);
					if ( !channel_id ) {
						clearTimeout(client.timeout);
						client.socket.end();
						break;
					}
					
					
					
					if ( channel_id ) {
						clearTimeout(client.timeout);
					
						client.state = 1;
						let room = ROOM.get(channel_id);
						if ( !room ) {
							room = {A:client, B:null};
							ROOM.set(channel_id, room);
							client.rslot = 'A';
						}
						else
						if ( room.A === null ) {
							room.A = client;
							client.rslot = 'A';
						}
						else
						if ( room.B === null ) {
							room.B = client;
							client.rslot = 'B';
						}
						else {
							room.B.socket.end();
							room.B = client;
							client.rslot = 'B';
						}
						
						client.room_id = channel_id;
						client.room = room;
						client.socket.write(Buffer.from([0x00, 0x00, 0x01, 0x01]));
						console.log(`[${GetLocalISOString()}] STAT(${SEGMENT_ID}:${IS_FIN_SEGMENT?'FIN':'CNT'}), ${client.id}, channel:${client.room_id}#${client.rslot}`);
					}
					
					continue;
				}
				
				
				
				
				const {room} = client;
				client.cache.push(segment);
				client.cache_size += segment.length;
				
				
				const paired_client = (room.A===client)?room.B:room.A;
				if ( !paired_client ) {
					console.log(`[${GetLocalISOString()}] SCHE(${SEGMENT_ID}:${IS_FIN_SEGMENT?'FIN':'CNT'}), ${client.id}, channel:${client.room_id||'-'}#${client.rslot}, len:${client.cache_size}`);
					continue;
				}
				
				
				
				for(const seg of client.cache.splice(0)) {
					console.log(`[${GetLocalISOString()}] SGMT(${SEGMENT_ID}:${IS_FIN_SEGMENT?'FIN':'CNT'}), ${client.id}, channel:${client.room_id||'-'}#${client.rslot}, len:${seg.length}`);
					if ( debug ) {
						console.log(`[${GetLocalISOString()}] SDAT, ${client.id}, channel:${client.room_id||'-'}#${client.rslot}, data:${seg.toString('hex')}`);
					}
					paired_client.socket.write(seg);
					client.cache_size -= seg.length;
				}
			}
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
		console.log(`[${GetLocalISOString()}] CERR, ${client.id}, channel:${client.room_id||'-'}#${client.rslot}, err:${e.code||e.message}`);
		
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
		console.log(`[${GetLocalISOString()}] CLOS, ${client.id}, channel:${client.room_id||'-'}#${client.rslot}`);
		
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
