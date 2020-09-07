/**
 *	Author: JCloudYu
 *	Create: 2020/08/26
**/
(()=>{
	"use strict";
	
	const ByteReader = require('./helper/byte-reader.js');
	const beson = require('beson');
	const events = require('events');
	const net = require('net');
	const GenInstId = require('./helper/gen-inst-id.js');
	
	
	
	const MAX_FRAME_CTNT_SIZE = 255;
	const MAX_FRAME_COUNTER = 255 + 1;
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
		client.payload_counter = 0;
		client.payload_info = Object.create(null);
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
		.on('_hello', _ON_HELLO)
		.on('_event', (event, arg)=>inst.emit(event, arg))
		.on('_disconnected', _ON_DISCONNECTED);
		
		
		
		const enumerable=true;
		Object.defineProperties(inst, {
			connect: {enumerable,value:_CONNECT},
			close: {enumerable,value:_CLOSE},
			invoke: {enumerable,value:_INVOKE},
			send_event: {enumerable:true,value:_SEND_EVENT},
			connected: {enumerable, get:_IS_CONNECTED}
		});
		
		
		
		if ( host !== undefined || port !== undefined ) {
			return _BUILD_CONNECTION.call(inst);
		}
		
		return inst;
	};
	
	function _CONNECT(port, host) {
		const client = PRIVATE.get(this);
		if ( client.state === 1 ) return this;
				
		client.remote_host = host;
		client.remote_port = port;
		return _BUILD_CONNECTION.call(this);
	}
	function _CLOSE() {
		const {socket} = PRIVATE.get(this);
		return new Promise((resolve, reject)=>{
			socket.end((err)=>err?reject(err):resolve());
		});
	}
	function _INVOKE(func, ...args) {
		const client = PRIVATE.get(this);
		const {state, serialize, req_duration} = client;
		const type = Buffer.from([MSG_TYPE.CALL]);
		const unique_id = GenInstId(true);
		const promise = new Promise((resolve, reject)=>{
			const str_id = Buffer.from(unique_id).toString('base64');
			client.cb_map.set(str_id, {
				res:resolve, rej:reject, timeout:req_duration<=0?null:setTimeout(()=>{
					reject(new Error("Timeout"));
					client.cb_map.delete(str_id);
				}, req_duration*1000)
			});
		});
		
		
		
		const func_name = Buffer.from(func, "utf8");
		const func_len = Buffer.alloc(2);
		func_len.writeUInt16LE(func_name.length);
		
		const arg_count = Buffer.from([args.length]);
		const buffer = [type, unique_id, func_len, func_name, arg_count];
		for(const arg of args) {
			const payload = arg===undefined?ZERO_BUFFER:Buffer.from(serialize(arg));
			const payload_len = Buffer.alloc(4);
			payload_len.writeUInt32LE(payload.length);
			buffer.push(payload_len);
			buffer.push(payload);
		}
		const payload = Buffer.concat(buffer);
		
		
		if ( state ) {
			___SEND_PAYLOAD(client, payload);
		}
		else {
			client.msg_caches.push(payload);
			client.cached_msg_size += payload.length;
		}
		
		return promise;
	}
	function _SEND_EVENT(event, arg) {
		const client = PRIVATE.get(this);
		const {state, serialize} = client;
		const type = Buffer.from([MSG_TYPE.EVNT]);
		const event_name = Buffer.from(event, "utf8");
		const event_len  = Buffer.alloc(2);
		event_len.writeUInt16LE(event_name.length);
		
		const evt_arg = arg===undefined?ZERO_BUFFER:Buffer.from(serialize(arg));
		const arg_len = Buffer.alloc(4);
		arg_len.writeUInt32LE(evt_arg.length);
		const payload = Buffer.concat([type, event_len, event_name, arg_len, evt_arg]);
		
		
		if ( state ) {
			___SEND_PAYLOAD(client, payload);
		}
		else {
			client.msg_caches.push(payload);
			client.cached_msg_size += payload.length;
		}
	}
	function _IS_CONNECTED() {
		return PRIVATE.get(this).state === 1;
	}
	function _BUILD_CONNECTION() {
		const client = PRIVATE.get(this);
		const {remote_host:host, remote_port:port} = client;
		
		return new Promise((resolve, reject)=>{
			client.socket = net.connect(port, host)
			.on('connect', _ON_CLIENT_CONN.bind(this))
			.on('data', _ON_CLIENT_DATA.bind(this))
			.on('end', (...args)=>{
				if ( resolve ) {
					const rej = reject;
					reject = null;
					resolve = null;
					rej();
				}
				
				_ON_CLIENT_END.call(this, ...args)
			})
			.on('error', (e)=>{
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
				res(this);
				
				this.emit('_hello');
			});
		});
	}
	function _ON_HELLO() {
		const client = PRIVATE.get(this);
		const caches = client.msg_caches.splice(0);
		for(const cache of caches) {
			___SEND_PAYLOAD(client, cache);
			client.cached_msg_size -= cache.length;
		}
		
		
		client.num_reties = 0;
		setTimeout(()=>this.emit('connected'), 0);
	}
	function _ON_DISCONNECTED() {
		const client = PRIVATE.get(this);
		
		client.num_reties++;
		if ( !client.auto_reconnect || ( client.retry_count > 0 && client.num_reties>client.retry_count) ) {
			this.emit('disconnected');
			return;
		}
		
		
		
		if ( client.socket ) {
			client.socket.removeAllListeners();
		}
		
		
		this.emit('reconnecting');
		setTimeout(()=>{
			_BUILD_CONNECTION.call(this).catch(()=>{});
		}, client.retry_interval*1000);
	}
	function _ON_CLIENT_CONN() {
		const client = PRIVATE.get(this);
		const channel = Buffer.from(client.channel_id, 'utf8');
		const payload = Buffer.alloc(3+channel.length);
		payload.writeUInt8(0x01, 0);
		payload.writeUInt16LE(channel.length, 1);
		channel.copy(payload, 3);
		
		
		___SEND_PAYLOAD(client, payload)
	}
	function _ON_CLIENT_DATA(chunk) {
		const client = PRIVATE.get(this);
		client.chunk = Buffer.concat([client.chunk, chunk]);
		
		CLIENT_STATE.queue.push(client);
		if ( !CLIENT_STATE.timeout ) {
			CLIENT_STATE.timeout = setTimeout(___PARSE_CLIENT_DATA, 0);
		}
	}
	function _ON_CLIENT_ERROR(e) {
		PRIVATE.get(this).state = 0;
		this.emit('_error', e);
		this.emit('_disconnected', e);
	}
	function _ON_CLIENT_END() {
		PRIVATE.get(this).state = 0;
		this.emit('_disconnected');
	}
	
	
	
	
	function ___SEND_PAYLOAD(client, payload) {
		const pid = client.payload_counter = (client.payload_counter+1) % MAX_FRAME_COUNTER;
		
		const num_chunks = Math.ceil(payload.length/MAX_FRAME_CTNT_SIZE);
		const final_chunk = num_chunks-1;
		for(let i=0; i<num_chunks; i++) {
			const from = i*MAX_FRAME_CTNT_SIZE, to = (i+1)*MAX_FRAME_CTNT_SIZE;
			const chunk = payload.slice(from, to);
			const header = Buffer.alloc(3);
			header.writeUInt8((i===final_chunk)?0x00:0x80);
			header.writeUInt8(pid, 1);
			header.writeUInt8(chunk.length, 2);
			client.socket.write(header);
			client.socket.write(chunk);
		}
	}
	function ___PARSE_CLIENT_DATA() {
		CLIENT_STATE.timeout = null;
	
		const clients = new Set(CLIENT_STATE.queue.splice(0));
		const messages = [];
		for(const client of clients) {
			if ( client.debug ) { console.log("client-data", client.chunk.toString('hex')); }
			if ( client.chunk.length === 0 ) continue;
			
			let batch_loop, client_messages = [];
			for(batch_loop=0; batch_loop<MAX_BATCH_MSG; batch_loop++) {
				const payload = ___EAT_PAYLOAD(client);
				if ( !payload ) continue;
				
				const message = ___EAT_MESSAGE(payload, client);
				if ( !message ) {
					// Incomplete message...
					continue;
				}
				
				if ( client.state === 0 ) {
					if ( message.type !== MSG_TYPE.HELO ) continue;
					
					client.state = 1;
					client.socket.emit('_hello');
					CLIENT_STATE.queue.push(client);
					if ( CLIENT_STATE.timeout === null ) {
						CLIENT_STATE.timeout = setTimeout(___PARSE_CLIENT_DATA, 0);
					}
					break;
				}
				
				client_messages.push(message);
			}
			
			if ( client.chunk.length > 0 && batch_loop>=MAX_BATCH_MSG ) {
				CLIENT_STATE.queue.push(client);
				if ( CLIENT_STATE.timeout === null ) {
					CLIENT_STATE.timeout = setTimeout(___PARSE_CLIENT_DATA, 0);
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
							const result = (arg===undefined)?ZERO_BUFFER:Buffer.from(client.serialize(arg));
							const payload = Buffer.alloc(25+result.length);
							payload.writeUInt8(MSG_TYPE.CALL_SUCC, 0);
							msg.unique_id.copy(payload, 1);
							payload.writeUInt32LE(result.length, 21);
							result.copy(payload, 25);
							
							___SEND_PAYLOAD(client, payload);
						},
						fail:(arg)=>{
							const result = (arg===undefined)?ZERO_BUFFER:Buffer.from(client.serialize(arg));
							const payload = Buffer.alloc(25+result.length);
							payload.writeUInt8(MSG_TYPE.CALL_FAIL, 0);
							msg.unique_id.copy(payload, 1);
							payload.writeUInt32LE(result.length, 21);
							result.copy(payload, 25);
							
							___SEND_PAYLOAD(client, payload);
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
	function ___EAT_PAYLOAD(client) {
		if ( client.chunk.length < 3 ) return false;
		
		const reader  = new ByteReader(client.chunk, 0);
		const ctrl	  = reader.readUInt8();
		const pid	  = reader.readUInt8();
		const length  = reader.readUInt8();
		const segment = reader.readBytes(length);
		if ( !segment ) return false;
		
		
		
		client.chunk = client.chunk.slice(reader.offset);
		
		const fin	= (ctrl & 0x80) === 0;
		const info	= client.payload_info[pid]||{d:ZERO_BUFFER, t:Date.now()};
		const data	= Buffer.concat([info.d, segment]);
		
		if ( fin ) {
			delete client.payload_info[pid];
			return data;
		}
		else {
			client.payload_info[pid] = info;
			info.d = data;
			info.t = Date.now();
			return false;
		}
	}
	function ___EAT_MESSAGE(payload, client) {
		const reader = new ByteReader(payload, 0);
		const cmd = reader.readUInt8();
		if ( cmd === null ) return null;
		
		// 0x01 + uint16 + bytes{0,}
		if ( cmd === MSG_TYPE.HELO ) {
			return {type:MSG_TYPE.HELO, client};
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
				
				if ( len <= 0 ) {
					args.push(undefined);
				}
				else {
					const arg = reader.readBytes(len);
					if ( arg === null ) return null;
					
					args.push(client.deserialize(arg));
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
			
			if ( len <= 0 ) {
				return { type:MSG_TYPE.CALL_SUCC, unique_id, result:undefined, client };
			}
			
			const result = reader.readBytes(len);
			if ( result === null ) return null;
			
			return { type:MSG_TYPE.CALL_SUCC, unique_id, result:client.deserialize(result), client };
		}
		
		// 0x04 + bytes{20} + uint32 + bytes{0,}
		if ( cmd === MSG_TYPE.CALL_FAIL ) {
			const unique_id = reader.readBytes(20);
			if ( unique_id === null ) return null;
			
			let len = reader.readUInt32LE();
			if ( len === null ) return null;
			
			if ( len <= 0 ) {
				return { type:MSG_TYPE.CALL_FAIL, unique_id, error:undefined, client };
			}
			
			
			const error = reader.readBytes(len);
			if ( error === null ) return null;
			
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
			
			if ( len <= 0 ) {
				return {type:MSG_TYPE.EVNT, event, arg:undefined, client};
			}
			
			
			const arg = reader.readBytes(len);
			if ( arg === null ) return null;
			
			return {type:MSG_TYPE.EVNT, event, arg:client.deserialize(arg), client};
		}
		
		
		return null;
	}
})();
