/**
 *	Author: JCloudYu
 *	Create: 2020/08/26
**/
(()=>{
	"use strict";
	
	const beson = require('beson');
	const events = require('events');
	const net = require('net');
	const GenInstId = require('./helper/gen-inst-id.js');
	
	
	
	const REQUEST_TIMEOUT = 10;
	const MAX_BATCH_MSG = 30;
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
		let {
			host, port, channel_id,
			invoke_timeout:req_timeout=REQUEST_TIMEOUT,
			auto_reconnect=false, retry_count=-1, retry_interval=5,
			debug=false, serializer=beson.Serialize, deserializer=beson.Deserialize
		} = options;
		if (!channel_id) {
			throw new Error("Destination host, port and channel_id must be assigned!");
		}
		
		if ( typeof serializer !== "function" || typeof deserializer !== "function" ) {
			throw new Error("Client serializer and deserializer must be functions!");
		}
		
		
		
		const inst = new events.EventEmitter();
		const client = Object.create(null);
		client.debug = !!debug;
		client.id = GenInstId();
		client.state = 0;
		client.chunk = ZERO_BUFFER;
		client.cb_map = new Map();
		client.socket = null;
		client.channel_id = channel_id;
		client.auto_reconnect = auto_reconnect;
		client.retry_count = retry_count|0;
		client.retry_interval = retry_interval|0;
		client.req_duration = req_timeout|0;
		client.remote_host = host;
		client.remote_port = port|0;
		client.inst = inst;
		client.msg_caches = [];
		client.cached_msg_size = 0;
		client.num_reties = 0;
		client.serialize = serializer;
		client.deserialize = deserializer;
		PRIVATE.set(inst, client);
		
		
		inst
		.on('_hello', ()=>{
			const socket = client.socket;
			const caches = client.msg_caches.splice(0);
			client.cached_msg_size = 0;
			for(const cache of caches) {
				socket.write(cache);
			}
			
			
			client.num_reties = 0;
			setTimeout(()=>inst.emit('connected'), 0);
		})
		.on('_event', (event, arg)=>inst.emit(event, arg))
		.on('_disconnected', ()=>{
			client.num_reties++;
			if ( !client.auto_reconnect || client.retry_count <= 0 || client.num_reties > client.retry_count ) {
				inst.emit('disconnected');
				return;
			}
			
			
			
			if ( client.socket ) {
				client.socket.removeAllListeners();
			}
			
			
			inst.emit('reconnecting');
			setTimeout(()=>{
				BuildConnection(client).catch((e)=>{});
			}, retry_interval * 1000);
		});
		
		
		
		Object.defineProperties(inst, {
			connect: {
				enumerable:true,
				value:function(port, host) {
					if ( client.state === 1 ) return this;
				
					client.remote_host = host;
					client.remote_port = port;
					return BuildConnection(client);
				}
			},
			close: {
				enumerable:true,
				value:function() {
					return new Promise((resolve, reject)=>{
						client.socket.end((err)=>err?reject(err):resolve());
					});
				}
			},
			invoke: {
				enumerable:true,
				value:function(func, ...args) {
					const client = PRIVATE.get(this);
					const {socket, state, serialize} = client;
					const type = Buffer.from([MSG_TYPE.CALL]);
					const unique_id = GenInstId(true);
					const promise = new Promise((resolve, reject)=>{
						const str_id = Buffer.from(unique_id).toString('base64');
						client.cb_map.set(str_id, {
							res:resolve, rej:reject, timeout:req_timeout<=0?null:setTimeout(()=>{
								reject(new Error("Timeout"));
								client.cb_map.delete(str_id);
							}, req_timeout * 1000)
						});
					});
					
					
					
					const func_name = Buffer.from(func, "utf8");
					const func_len = Buffer.alloc(2);
					func_len.writeUInt16LE(func_name.length);
					
					const arg_count = Buffer.from([args.length]);
					if ( state ) {
						socket.write(type);
						socket.write(unique_id);
						socket.write(func_len);
						socket.write(func_name);
						socket.write(arg_count);
						for(const arg of args) {
							const payload = Buffer.from(serialize(arg));
							const payload_len = Buffer.alloc(4);
							payload_len.writeUInt32LE(payload.length);
							socket.write(payload_len);
							socket.write(payload);
						}
					}
					else {
						const buffer = [type, unique_id, func_len, func_name, arg_count];
						for(const arg of args) {
							const payload = Buffer.from(serialize(arg));
							const payload_len = Buffer.alloc(4);
							payload_len.writeUInt32LE(payload.length);
							buffer.push(payload_len);
							buffer.push(payload);
						}
						
						const msg_buffer = Buffer.concat(buffer);
						client.msg_caches.push(msg_buffer);
						client.cached_msg_size += msg_buffer.length;
					}
					
					return promise;
				}
			},
			send_event: {
				enumerable:true,
				value:function(event, arg) {
					const client = PRIVATE.get(this);
					const {socket, state, serialize} = client;
					const type = Buffer.from([MSG_TYPE.EVNT]);
					const event_name = Buffer.from(event, "utf8");
					const event_len  = Buffer.alloc(2);
					event_len.writeUInt16LE(event_name.length);
					
					const payload = Buffer.from(serialize(arg));
					const payload_len = Buffer.alloc(4);
					payload_len.writeUInt32LE(payload.length);
					
					
					
					if ( state ) {
						socket.write(type);
						socket.write(event_len);
						socket.write(event_name);
						socket.write(payload_len);
						socket.write(payload);
					}
					else {
						const msg_buffer = Buffer.concat([type, event_len, event_name, payload_len, payload]);
						client.msg_caches.push(msg_buffer);
						client.cached_msg_size += msg_buffer.length;
					}
				}
			},
			connected: {
				enumerable:true,
				get(){ return client.state === 1; },
			}
		});
		
		if ( host !== undefined || port !== undefined ) {
			return BuildConnection(client);
		}
		
		return inst;
	};
	function BuildConnection(client) {
		const {remote_host:host, remote_port:port, inst} = client;
		
		return new Promise((resolve, reject)=>{
			client.socket = net.connect(port, host)
			.on('connect', _ON_CLIENT_CONN.bind(client))
			.on('data', _ON_CLIENT_DATA.bind(client))
			.on('end', function(...args) {
				if ( resolve ) {
					const rej = reject;
					reject = null;
					resolve = null;
					rej();
				}
				
				_ON_CLIENT_END.call(client, ...args)
			})
			.on('error', function(e) {
				if ( reject ) {
					const rej = reject;
					reject = null;
					rej(e);
				}
				
				_ON_CLIENT_ERROR.call(client, e);
			})
			.on('_hello', ()=>{
				const res = resolve;
				resolve = null;
				res(client.inst);
				
				inst.emit('_hello');
			});
		});
	}
	function _PARSE_CLIENT_DATA() {
		CLIENT_STATE.timeout = null;
	
		const clients = new Set(CLIENT_STATE.queue.splice(0));
		const messages = [];
		for(const client of clients) {
			if ( client.debug ) {
				console.log(client.chunk.toString('hex'));
			}
			
			
			
			if ( client.chunk.length === 0 ) continue;
			
			
			
			const client_messages=[]; let loop=0;
			for(loop=0; loop<MAX_BATCH_MSG; loop++) {
				const message = ___EAT_MESSAGE(client);
				if ( message === null ) break;
				if ( message === false ) continue;
				
				
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
					client.inst.emit('call', {
						success:(arg)=>{
							client.socket.write(Buffer.from([MSG_TYPE.CALL_SUCC]));
							client.socket.write(msg.unique_id);
							
							const len = Buffer.alloc(4);
							if ( arg === undefined ) {
								len.writeUInt32LE(0);
								client.socket.write(len);
							}
							else {
								const payload = Buffer.from(client.serialize(arg));
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
								const payload = Buffer.from(client.serialize(arg));
								len.writeUInt32LE(payload.length);
								client.socket.write(len);
								client.socket.write(payload);
							}
						}
					}, msg.func, ...msg.args);
					break;
				}
				
				case MSG_TYPE.EVNT: {
					client.inst.emit('_event', msg.event, msg.arg);
					break;
				}
				
				case MSG_TYPE.CALL_SUCC: {
					const str_id = msg.unique_id.toString('base64');
					const cb = client.cb_map.get(str_id);
					if ( cb ) {
						if ( cb.timeout ) clearTimeout(cb.timeout);
						client.cb_map.delete(str_id);
						cb.res(msg.result);
					}
					break;
				}
				
				case MSG_TYPE.CALL_FAIL: {
					const str_id = msg.unique_id.toString('base64');
					const cb = client.cb_map.get(str_id);
					if ( cb ) {
						if ( cb.timeout ) clearTimeout(cb.timeout);
						client.cb_map.delete(str_id);
						cb.rej(msg.error);
					}
					break;
				}
			}
		}
	}
	function ___EAT_MESSAGE(client) {
		const reader = new BufferReader(client.chunk, 0);
		const cmd = reader.readUInt8();
		if ( cmd === null ) return null;
		
		
		
		// 0x01 + uint16 + bytes{0,}
		if ( cmd === MSG_TYPE.HELO ) {
			client.chunk = client.chunk.slice(reader.offset);
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
					
					args.push(client.deserialize(arg));
				}
			}
			
			if ( args.length !== num_args ) return null;
			
			
			
			client.chunk = client.chunk.slice(reader.offset);
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
			
			
			
			client.chunk = client.chunk.slice(reader.offset);
			return { type:MSG_TYPE.CALL_SUCC, unique_id, result:client.deserialize(result), client };
		}
		
		
		
		// 0x04 + bytes{20} + uint32 + bytes{0,}
		if ( cmd === MSG_TYPE.CALL_FAIL ) {
			const unique_id = reader.readBytes(20);
			if ( unique_id === null ) return null;
			
			let len = reader.readUInt32LE();
			if ( len === null ) return null;
			
			const error = len <=0 ? undefined : reader.readBytes(len);
			if ( error === null ) return null;
			
			
			
			client.chunk = client.chunk.slice(reader.offset);
			return { type:MSG_TYPE.CALL_FAIL, unique_id, error:client.deserialize(error), client };
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
			
			
			
			client.chunk = client.chunk.slice(reader.offset);
			return {type:MSG_TYPE.EVNT, event, arg:client.deserialize(arg), client};
		}
		
		
		return false;
	}
	
	
	
	function _ON_CLIENT_CONN() {
		const {socket, channel_id} = this;
		const encoded_channel_id = Buffer.from(channel_id, 'utf8');
		
		const length = new Uint16Array(1);
		length[0] = encoded_channel_id.length;
		
		
		socket.write(Buffer.from([0x01]));
		socket.write(Buffer.from(length.buffer));
		socket.write(encoded_channel_id);
	}
	function _ON_CLIENT_DATA(chunk) {
		this.chunk = Buffer.concat([this.chunk, chunk]);
		
		CLIENT_STATE.queue.push(this);
		if ( !CLIENT_STATE.timeout ) {
			CLIENT_STATE.timeout = setTimeout(_PARSE_CLIENT_DATA, 0);
		}
	}
	function _ON_CLIENT_ERROR(e) {
		this.state = 0;
		this.inst.emit('_error', e);
		this.inst.emit('_disconnected', e);
	}
	function _ON_CLIENT_END() {
		this.state = 0;
		this.inst.emit('_disconnected');
	}
})();
