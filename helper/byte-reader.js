/**
 *	Author: JCloudYu
 *	Create: 2020/09/05
**/
module.exports = class BufferReader {
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
};
