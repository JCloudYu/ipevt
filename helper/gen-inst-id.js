/**
 *	Author: JCloudYu
 *	Create: 2020/06/28
**/
// See http://www.isthe.com/chongo/tech/comp/fnv/#FNV-param for the definition of these parameters;
(()=>{
	const FNV_PRIME_HIGH = 0x0100, FNV_PRIME_LOW = 0x0193;	// 16777619 0x01000193
	const OFFSET_BASIS = new Uint8Array([0xC5, 0x9D, 0x1C, 0x81]);	// 2166136261 [0x81, 0x1C, 0x9D, 0xC5]
	const HOSTNAME_CANDIDATES = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWZYZ_-";
	const BASE64SORT_ENCODE_CHAR = '0123456789=ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'.split('');
	const {PID, PPID, MACHINE_ID} = (()=>{
		let host = '', pid = (Math.random() * 65535)|0, ppid = (Math.random() * 65535)|0;
		
		if ( typeof Buffer !== "undefined" ) {
			const os = require('os');
			host = os.hostname();
			pid	 = process.pid;
			ppid = process.ppid;
		}
		else
		if ( typeof window == "undefined" ) {
			host = window.location.host;
		}
		else {
			let count = 30;
			while(count-- > 0) {
				host += HOSTNAME_CANDIDATES[(Math.random() * HOSTNAME_CANDIDATES.length)|0]
			}
		}
		
		
		
		return { MACHINE_ID:fnv1a32(UTF8Encode(host)), PID:pid, PPID:ppid };
	})();
	let SEQ_NUMBER = Math.floor(Math.random() * 0xFFFFFFFF);
	
	
	
	
	
	if ((typeof module !== "undefined") && module.exports) {
		module.exports = GenInstId;
		return;
	}
	if ( typeof window !== "undefined" ) {
		window.GenInstId = GenInstId;
		return;
	}
	
	
	
	
	
	
	function GenInstId(output_buffer=false) {
		const time	= Date.now();
		const time_upper = Math.floor(time/0xFFFFFFFF);
		const time_lower = time%0xFFFFFFFF;
		const inc	= (SEQ_NUMBER=(SEQ_NUMBER+1) % 0xFFFFFFFF);
		const buff	= new Uint8Array(20);
		const view	= new DataView(buff.buffer);
		
		view.setUint32(0, time_upper, false);		// [0-3] epoch time upper
		view.setUint32(4, time_lower, false);		// [4-7] epoch time lower
		buff.set(new Uint8Array(MACHINE_ID), 8);	// [8-11] machine id
		view.setUint16(12, PPID, false);			// [12-13] ppid
		view.setUint16(14, PID,  false);			// [14-15] pid
		view.setUint32(16, inc,	 false);			// [16-19] seq
		
		
		
		return output_buffer ? buff : Base64SortEncode(buff);
	}
	
	
	
	function fnv1a32(octets){
		const RESULT_DATA = OFFSET_BASIS.slice(0);
		const HASH_RESULT = new Uint32Array(RESULT_DATA.buffer);
		const RESULT_PROC = new Uint16Array(RESULT_DATA.buffer);
		for( let i = 0; i < octets.length; i += 1 ) {
			HASH_RESULT[0] = HASH_RESULT[0] ^ octets[i];
			
			let hash_low = RESULT_PROC[0], hash_high = RESULT_PROC[1];
			
			RESULT_PROC[0] = hash_low * FNV_PRIME_LOW;
			RESULT_PROC[1] = hash_low * FNV_PRIME_HIGH + hash_high * FNV_PRIME_LOW + (RESULT_PROC[0]>>>16);
		}
		return new Uint8Array(HASH_RESULT.buffer);
	}
	function Base64SortEncode(bytes) {
		var v1, v2, v3, base64Str = '', length = bytes.length;
		for( var i = 0, count = ((length/3)>>>0) * 3; i < count; ){
			v1 = bytes[i++];
			v2 = bytes[i++];
			v3 = bytes[i++];
			base64Str += BASE64SORT_ENCODE_CHAR[v1 >>> 2] +
				BASE64SORT_ENCODE_CHAR[(v1 << 4 | v2 >>> 4) & 63] +
				BASE64SORT_ENCODE_CHAR[(v2 << 2 | v3 >>> 6) & 63] +
				BASE64SORT_ENCODE_CHAR[v3 & 63];
		}
		
		// remain char
		var remain = length - count;
		if( remain === 1 ){
			v1 = bytes[i];
			base64Str += BASE64SORT_ENCODE_CHAR[v1 >>> 2] + BASE64SORT_ENCODE_CHAR[(v1 << 4) & 63] + '';
		}
		else if( remain === 2 ){
			v1 = bytes[i++];
			v2 = bytes[i];
			base64Str += BASE64SORT_ENCODE_CHAR[v1 >>> 2] + BASE64SORT_ENCODE_CHAR[(v1 << 4 | v2 >>> 4) & 63] + BASE64SORT_ENCODE_CHAR[(v2 << 2) & 63] + '';
		}
		return base64Str;
	}
	function UTF8Encode(str) {
		if ( typeof str !== "string" ) {
			throw new TypeError( "Given input argument must be a js string!" );
		}
	
		let codePoints = [];
		let i=0;
		while( i < str.length ) {
			let codePoint = str.codePointAt(i);
			
			// 1-byte sequence
			if( (codePoint & 0xffffff80) === 0 ) {
				codePoints.push(codePoint);
			}
			// 2-byte sequence
			else if( (codePoint & 0xfffff800) === 0 ) {
				codePoints.push(
					0xc0 | (0x1f & (codePoint >> 6)),
					0x80 | (0x3f & codePoint)
				);
			}
			// 3-byte sequence
			else if( (codePoint & 0xffff0000) === 0 ) {
				codePoints.push(
					0xe0 | (0x0f & (codePoint >> 12)),
					0x80 | (0x3f & (codePoint >> 6)),
					0x80 | (0x3f & codePoint)
				);
			}
			// 4-byte sequence
			else if( (codePoint & 0xffe00000) === 0 ) {
				codePoints.push(
					0xf0 | (0x07 & (codePoint >> 18)),
					0x80 | (0x3f & (codePoint >> 12)),
					0x80 | (0x3f & (codePoint >> 6)),
					0x80 | (0x3f & codePoint)
				);
			}
			
			i += (codePoint>0xFFFF) ? 2 : 1;
		}
		return new Uint8Array(codePoints);
	}
})();
