/**
 *	Author: JCloudYu
 *	Create: 2020/08/26
**/
(()=>{
	"use strict";
	
	const beson = require('beson');
	const net = require('net');
	const GenInstId = require('./helper/gen-inst-id.js');
	
	
	
	const REQUEST_TIMEOUT = 10;
	const MAX_BATCH_MSG = 100;
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
	const CLIENT_STATE = {timeout:null, queue:[]};
	
	
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
	
	
	
	
	
	
	
	module.exports = function(options) {
		let {host, port, channel_id, debug=false} = options;
		if ( !host || !port || !channel_id ) {
			throw new Error("Destination host, port and channel_id must be assigned!");
		}
		
	
		return new Promise((resolve, reject)=>{
			const client = Object.create(null);
			const socket = net.connect(port, host)
			.on('connect', _ON_CLIENT_CONN)
			.on('data', _ON_CLIENT_DATA)
			.on('end', function(...args) {
				if ( resolve ) {
					const rej = reject;
					reject = null;
					rej();
				}
				
				_ON_CLIENT_END.call(this, ...args)
			})
			.on('error', function(e) {
				if ( reject ) {
					const rej = reject;
					reject = null;
					rej(e);
				}
				
				_ON_CLIENT_ERROR.call(this, e);
			})
			.on('_hello', ()=>{
				const res = resolve;
				resolve = null;
				res(socket);
			});
			
			
			client.debug 		= !!debug;
			client.id			= GenInstId();
			client.state		= 0;
			client.chunk		= ZERO_BUFFER;
			client.channel_id	= channel_id;
			client.socket		= socket;
			client.cb_map		= new Map();
			PRIVATE.set(socket, client);
			
			
			socket.invoke = function(func, ...args) {
				const type = Buffer.from([MSG_TYPE.CALL]);
				const unique_id = GenInstId(true);
				const promise = new Promise((resolve, reject)=>{
					const str_id = Buffer.from(unique_id).toString('base64');
					client.cb_map.set(str_id, {
						res:resolve, rej:reject, timeout:setTimeout(()=>{
							reject(new Error("Timeout"));
							client.cb_map.delete(str_id);
						}, REQUEST_TIMEOUT * 1000)
					});
				});
				
				
				
				const func_name = Buffer.from(func, "utf8");
				const func_len = Buffer.alloc(2);
				func_len.writeUInt16LE(func_name.length);
				
				const arg_count = Buffer.from([args.length]);
				socket.write(type);
				socket.write(unique_id);
				socket.write(func_len);
				socket.write(func_name);
				socket.write(arg_count);
				for(const arg of args) {
					const payload = Buffer.from(beson.Serialize(arg));
					const payload_len = Buffer.alloc(4);
					payload_len.writeUInt32LE(payload.length);
					socket.write(payload_len);
					socket.write(payload);
				}
				
				
				return promise;
			};
			socket.send_event = function(event, arg) {
				const type = Buffer.from([MSG_TYPE.EVNT]);
				const event_name = Buffer.from(event, "utf8");
				const event_len  = Buffer.alloc(2);
				event_len.writeUInt16LE(event_name.length);
				
				socket.write(type);
				socket.write(event_len);
				socket.write(event_name);
				
				const payload = Buffer.from(beson.Serialize(arg));
				const payload_len = Buffer.alloc(4);
				payload_len.writeUInt32LE(payload.length);
				socket.write(payload_len);
				socket.write(payload);
			};
		});
	};
	
	
	
	
	function _PARSE_CLIENT_DATA() {
		CLIENT_STATE.timeout = null;
	
		const clients = new Set(CLIENT_STATE.queue.splice(0));
		const messages = [], reader = new BufferReader();
		for(const client of clients) {
			if ( client.debug ) {
				console.log(client.chunk.toString('hex'));
			}
			
			
			
			if ( client.chunk.length === 0 ) continue;
			reader.bindBuffer(client.chunk, 0);
			
			
			const client_messages=[]; let has_data = false, loop=0;
			for(loop=0; loop<MAX_BATCH_MSG; loop++) {
				const message = ___EAT_MESSAGE(reader, client);
				if ( message === null ) break;
				if ( message === false ) continue;
				has_data = true;
				
				
				if ( client.state === 0 ) {
					if ( message.type !== MSG_TYPE.HELO ) continue;
					
					client.state = 1;
					client.socket.emit('_hello');
					CLIENT_STATE.queue.push(client);
					if ( CLIENT_STATE.timeout === null ) {
						CLIENT_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
					}
					break;
				}
				
				client_messages.push(message);
			}
			
			if ( has_data ) {
				client.chunk = client.chunk.slice(reader.offset);
			}
			
			
			if ( client.chunk.length > 0 && client_messages.length > 0 ) {
				CLIENT_STATE.queue.push(client);
				if ( CLIENT_STATE.timeout === null ) {
					CLIENT_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
				}
			}
			
			for(const msg of client_messages) messages.push(msg);
		}

	
		for(const msg of messages) {
			const {client} = msg;
			switch(msg.type) {
				case MSG_TYPE.CALL: {
					client.socket.emit('call', {
						success:(arg)=>{
							client.socket.write(Buffer.from([MSG_TYPE.CALL_SUCC]));
							client.socket.write(msg.unique_id);
							
							const len = Buffer.alloc(4);
							if ( arg === undefined ) {
								len.writeUInt32LE(0);
								client.socket.write(len);
							}
							else {
								const payload = Buffer.from(beson.Serialize(arg));
								len.writeUInt32LE(payload.length);
								
								client.socket.write(len);
								client.socket.write(payload);
							}
						},
						fail:(arg)=>{
							client.socket.write(Buffer.from([MSG_TYPE.CALL_FAIL]));
							client.socket.write(msg.unique_id);
							
							const len = Buffer.alloc(4);
							if ( arg === undefined ) {
								len.writeUInt32LE(0);
								client.socket.write(len);
							}
							else {
								const payload = Buffer.from(beson.Serialize(arg));
								len.writeUInt32LE(payload.length);
								client.socket.write(len);
								client.socket.write(payload);
							}
						}
					}, msg.func, ...msg.args);
					break;
				}
					
				case MSG_TYPE.EVNT: {
					client.socket.emit(msg.event, msg.arg);
					break;
				}
				
				case MSG_TYPE.CALL_SUCC: {
					const str_id = msg.unique_id.toString('base64');
					const cb = client.cb_map.get(str_id);
					clearTimeout(cb.timeout);
					client.cb_map.delete(str_id);
					cb.res(msg.result);
					break;
				}
				
				case MSG_TYPE.CALL_FAIL: {
					const str_id = msg.unique_id.toString('base64');
					const cb = client.cb_map.get(str_id);
					clearTimeout(cb.timeout);
					client.cb_map.delete(str_id);
					cb.rej(msg.error);
					break;
				}
			}
		}
	}
	function ___EAT_MESSAGE(reader, client) {
		const cmd = reader.readUInt8();
		if ( cmd === null ) return null;
		
		
		
		// 0x01 + uint16 + bytes{0,}
		if ( cmd === MSG_TYPE.HELO ) {
			return { type:MSG_TYPE.HELO, client };
		}
		
		
		
		// 0x02 + bytes{20} + uint16 + bytes{0,} + uint8 + (uint32 + bytes{0,}){0,256}
		if ( cmd === MSG_TYPE.CALL ) {
			const unique_id = reader.readBytes(20);
			if ( unique_id === null ) return null;
			
			let len = reader.readUInt16LE();
			if ( len === null ) return null;
			
			const func = reader.readUTF8String(len);
			if ( len === null ) return null;
			
			const num_args = reader.readUInt8();
			if ( num_args === null ) return null;
			
			
			const args = [];
			for(let i=0; i<num_args; i++) {
				len = reader.readUInt32LE();
				if ( len === null ) return null;
				
				if ( len === 0 ) {
					args.push(undefined);
				}
				else {
					const arg = reader.readBytes(len);
					if ( arg === null ) return null;
					
					args.push(beson.Deserialize(arg));
				}
			}
			
			if ( args.length !== num_args ) return null;
			
			return { type:MSG_TYPE.CALL, unique_id, func, args, client };
		}
		
		
		
		// 0x03 + bytes{20} + uint32 + bytes{0,}
		if ( cmd === MSG_TYPE.CALL_SUCC ) {
			const unique_id = reader.readBytes(20);
			if ( unique_id === null ) return null;
			
			let len = reader.readUInt32LE();
			if ( len === null ) return null;
			
			const result = len <=0 ? undefined : reader.readBytes(len);
			if ( result === null ) return null;
			
			
			return { type:MSG_TYPE.CALL_SUCC, unique_id, result:beson.Deserialize(result), client };
		}
		
		
		
		// 0x04 + bytes{20} + uint32 + bytes{0,}
		if ( cmd === MSG_TYPE.CALL_FAIL ) {
			const unique_id = reader.readBytes(20);
			if ( unique_id === null ) return null;
			
			let len = reader.readUInt32LE();
			if ( len === null ) return null;
			
			const error = len <=0 ? undefined : reader.readBytes(len);
			if ( error === null ) return null;
			
			
			return { type:MSG_TYPE.CALL_FAIL, unique_id, error:beson.Deserialize(error), client };
		}
		
		
		
		// 0x05 + uint16 + bytes{0,} + uint32 + bytes{0,}
		if ( cmd === MSG_TYPE.EVNT ) {
			let len = reader.readUInt16LE();
			if ( len === null ) return null;
			
			const event = reader.readUTF8String(len);
			if ( event === null ) return null;
			
			len = reader.readUInt32LE();
			if ( len === null ) return null;
			
			const arg = reader.readBytes(len);
			if ( arg === null ) return null;
			
			
			
			return {type:MSG_TYPE.EVNT, event, arg:beson.Deserialize(arg), client};
		}
		
		
		return false;
	}
	
	
	
	
	function _ON_CLIENT_CONN() {
		const client = PRIVATE.get(this);
		const {channel_id} = client;
		const encoded_channel_id = Buffer.from(channel_id, 'utf8');
		
		const length = new Uint16Array(1);
		length[0] = encoded_channel_id.length;
		
		
		this.write(Buffer.from([0x01]));
		this.write(Buffer.from(length.buffer));
		this.write(encoded_channel_id);
	}
	function _ON_CLIENT_DATA(chunk) {
		const client = PRIVATE.get(this);
		client.chunk = Buffer.concat([client.chunk, chunk]);
		
		CLIENT_STATE.queue.push(client);
		if ( !CLIENT_STATE.timeout ) {
			CLIENT_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
		}
	}
	function _ON_CLIENT_ERROR(e) {
		const client = PRIVATE.get(this);
		console.error(`[${client.id}]: ERROR, channel:${client.channel_id}, error:${e.message}!`);
		console.error(e);
	}
	function _ON_CLIENT_END(e) {
		const client = PRIVATE.get(this);
		console.log(`[${client.id}]: CLOSE, channel:${client.channel_id}`);
	}
})();
