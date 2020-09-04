/**
 *	Author: JCloudYu
 *	Create: 2020/08/27
**/
(async()=>{
	"use strict";
	
	const beson = require('beson');
	const ipevt = require('../ipevt-client.js');
	const client = await ipevt({
		host:'127.0.0.1', port:65500,
		channel_id:'channel1', invoke_timeout:3,
		auto_reconnect:true, retry_count:-1, retry_interval:10,
		debug:false,
		serializer:beson.Serialize,
		deserializer:beson.Deserialize,
	});
	console.log("CONNECTED");
	

	const numbers = [];
	client
	.on('connected', ()=>{
		console.log("connected 2");
	})
	.on('disconnected', ()=>{
		console.log("disconnected");
	})
	.on('reconnecting', ()=>{
		console.log("reconnecting");
	})
	.on('count', (arg)=>{
		console.log( `count: ${arg}` );
		numbers.push(arg);
	})
	.on('fin', ()=>{
		console.log( `fin: ${numbers.length}` );
		for(let i=0; i<(numbers.length-1); i++) {
			if ( numbers[i+1] - numbers[i] > 1 ) {
				console.log(numbers[i], numbers[i+1]);
			}
		}
	})
	.on('call', (res, func, ...args)=>{
		if ( func === "echo" ) {
			const num = args[0]|0;
			if ( num%2 === 0 ) {
				res.success(num);
			}
			else {
				res.fail(num);
			}
		}
		else {
			res.fail(null);
		}
	});
})();
