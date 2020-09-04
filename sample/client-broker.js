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
		auto_reconnect:true, retry_count:10, retry_interval:10,
		debug:false,
		serializer:beson.Serialize,
		deserializer:beson.Deserialize,
	});
	console.log("CONNECTED");
	
	
	client
	.on('connected', ()=>{
		console.log("connected 2");
	})
	.on('disconnected', ()=>{
		console.log("disconnected");
		process.exit(0);
	})
	.on('reconnecting', ()=>{
		console.log("reconnecting");
	});
	
	
	
	let counting = 1, pass = [], fail = [];
	for(let j=0; j<5000; j++) {
		const promises = [];
		for(let i=0; i<10; i++) {
			let c = counting++;
			promises.push(client.invoke('echo', c, c+1)
			.then((r)=>{
				console.log(`${c}: ${r}`);
				pass.push(r);
			})
			.catch((r)=>{
				if ( r instanceof Error) {
					console.error(r);
					return;
				}
				
				console.log(`${c}: ${r}`);
				fail.push(r);
			}));
			
			client.send_event('count', c);
		}
		await Promise.all(promises);
	}
	client.send_event('fin');
	
	console.log(pass.length, fail.length);
	
	process.exit(0);
})();
