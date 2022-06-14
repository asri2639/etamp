const LRU = require("lru-cache");
const cache = LRU({
	maxAge: 0,
	max: 0,
	length: function (n, key) { return n * 2 + key.length },
	dispose: function (key, n) { n.close() }
})
 function setValue(key,value){
	cache.set(key,value);
}
 function getValue(key){
	//var promise=Promise.resolve(n*10);
	return cache.get(key);
}
 function hasKey(key){
	return cache.has(key);
}
module.exports = {
  setValue: setValue,
  getValue: getValue,
  hasKey: hasKey
};