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
		channel_id:'channel1', timeout:10,
		auto_reconnect:true, retry_count:3,
		serializer:beson.Serialize,
		deserializer:beson.Deserialize,
	});
	console.log("CONNECTED");
	
	client.on('disconnected', ()=>{
		console.log("disconnected");
		process.exit(0);
	})
	.on('reconnecting', ()=>{
		console.log("reconnecting");
	})
	.on('count', (arg)=>{
		console.log( "Receiving count event from other peer!", arg );
	});
	
	let counting = 1;
	for(let j=0; j<10000; j++) {
		const promises = [];
		for(let i=0; i<10; i++) {
			promises.push(client.invoke('add_call', counting, counting+1).catch((r)=>{console.log("error", r); return r;}));
			client.send_event('count', counting++)
		}
		await Promise.all(promises).then((r)=>{console.log(r);});
	}
	process.exit(1);
})();
