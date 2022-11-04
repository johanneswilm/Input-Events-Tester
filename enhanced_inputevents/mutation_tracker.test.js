import { MutationTracker, toggle_staticrange } from "./mutation_tracker.js";
// Helpers for DOM creation
let uid = 0;
function node(){
	const s = document.createElement("div");
	s.id = s.uid = uid++;
	return s;
}
function nodes(n){
	let lst = [];
	for (let i=0; i<n; i++)
		lst.push(node());
	return lst;
}
function text(str){
	const t = document.createTextNode(str);
	t.uid = uid++;
	return t;
}

const allowed_attrs = ["class"];

/** Create a cache of a DOM tree */
class CachedDOM{
	constructor(node){
		this.node = node;
		this.children = [];
		this.attrs = {};
		if (node.nodeType instanceof CharacterData)
			this.attrs.data = node.data;
		else{
			if (node.getAttribute?.constructor === Function){
				for (let k of allowed_attrs)
					attrs[k] = node.getAttribute(k);
			}
			for (let c of node.childNodes)
				children.push(new CachedDom(c));
		}
	}
	/** Check for differences with another CachedDom
	 * @param {CachedDOM} other other DOM to compare against
	 * @param {Boolean} forward whether to iterate childNodes forward or backward;
	 * 	can be used to get left/right bounds of differences
	 * @returns false, if there are no differences; otherwise a stack of ancestors leading
	 * 	to the differing node, each entry of the form:
	 * 	{
	 * 		a: node from this
	 * 		b: node from other
	 * 		index: index into parent's childNodes (not present for first entry in stack)
	 * 		details: details about why they differ (only for final entry in stack)
	 * 	}
	 */
	diff(other, forward=true){
		let stack = [{a: this, b: other}];
		let msg = this.#diff_rec(other, forward, stack);
		if (!msg)
			return false;
		stack[stack.length-1].details = msg;
		return stack;
	}
	_diff_rec(other, forward, stack){
		if (this.node !== other.node)
			return "nodes are different";
		if (Object.keys(this.attrs).length != Object.keys(other.attrs).length)
			return "different number of attributes";
		for (let k in this.attrs){
			if (!(k in other.attrs))
				return `missing attribute ${k}`;
			let tv = this.attrs[k], ov = other.attrs[k];
			if (ov !== tv)
				return `differing attribute ${k}: ${tv} vs ${ov}`;
		}
		// recurse on children
		let l = Math.max(this.children.length, other.children.length);
		for (let i=(forward ? 0 : l-1); forward ? i<l : i>=0; forward ? i++ : i--){
			let a = this.children[i];
			let b = other.children[i];
			stack.push({a,b,index:i});
			if (!a)
				return "a is missing a child node";
			if (!b)
				return "b is missing a child node";
			let msg = a._diff_rec(b, forward, stack);
			if (msg)
				return msg;
			stack.pop();
		}
	}
}

/** Helper class to run tests
 * - Use `start` to start tracking a DOM, and `stop` when mutations are finished.
 * - Use `check_revert` to revert the DOM and check that it performed correctly;
 *		If failed, dom_[original, mutated, reverted], range, and mutated can be examined
 */
class Tester{
	constructor(){
		this.dom_original = null;
		this.tracker = new MutationTracker();
		this.observer = new MutationObserver(this.record.bind(this, null));
	}
	record(records){
		for (let r of records)
			this.tracker.record(r);
	}
	/** Start tracking/observing root */
	start(root){
		this.root = root;
		this.dom_original = new CachedDOM(root);
		this.tracker.clear();
		this.observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: allowed_attrs,
			attributeOldValue: true,
			characterData: true, 
			characterDataOldValue: true,
		});
	}
	/** Start tracking/observing previously set root */
	stop(){
		this.record(this.observer.takeRecords());
		this.observer.disconnect();
	}
	/** Try reverting and see if it works */
	check_revert(){
		this.dom_mutated = new CachedDOM(this.root);
		this.range = toggle_staticrange(this.tracker.range(this.root));
		this.tracker.revert();
		this.dom_reverted = new CachedDOM(this.root);
		// check mutated
		let fdiff = this.dom_original.diff(this.dom_mutated);
		this.mutated = this.tracker.mutated(this.root);
		if (mutated != !!fdiff){
			console.error(fdiff);
			throw Error("mutated incorrect");
		}
		if (mutated != !!this.range){
			console.error(this.range);
			throw Error("range doesn't match mutated");
		}
		// check range has correct bounds
		if (this.range){
			let bdiff = this.dom_original.diff(this.dom_mutated, false);
			// convert diff to an equivalent range
			if (fdiff.length <= 1 || bdiff.length <= 1)
				throw Error("assertion: root has been modified");
			let spec = {};
			spec.startContainer = fdiff.get(-2).a;
			spec.startOffset = fdiff.get(-1).index;
			let end = spec.endContainer = bdiff.get(-2).a;
			spec.endOffset = Math.min(bdiff.get(-1).index, end.children;



		}
		
		// check revert
		let diff = Tester.deep_diff(this.dom_original, this.dom_reverted);
		if (diff){
			console.error(diff);
			throw Error("revert failed");
		}
	}

	/** Cache DOM to check for equality later */
	static cache(dom){
		
	}
	
	/** Check for equality, recursing on literal arrays and objects
	 * @param a first value to compare
	 * @param b second value to compare
	 * @param {Boolean} forward whether to traverse arrays forward, or false for backward;
	 * 	finding the diff forward and backward can give you bounds for the difference
	 * @returns false if equal, otherwise object {
	 * 	path: nested path to different objects,
	 * 	stack: a list of pairs [a,b], indicating the object comparison stack; each pair corresponds
	 * 		to the slice in `path`; the last pair is the values that were different
	 * 	msg: more descriptive message of the difference
	 * }
	 */
	static deep_diff(a, b, forward=true, log=null){
		// Note: disabling the shortcut length checks, so we can get an
		// 	exact index of where difference is
		function type(v){
			if (Array.isArray(v))
				return 0;
			if (!!v && v.constructor === Object)
				return 1;
			return 2;
		}
		if (log === null)
			log = {path: [], stack: []};
		log.diff = [a,b];
		const at = type(a), bt = type(b);
		if (at !== bt){
			log.msg = "types differ";
			return log;
		}
		switch (at){
			// array recursion
			case 0:
				/*if (a.length !== b.length){
					log.msg = "array lengths differ";
					return log;
				}*/
				log.stack.push(0);
				for (let i=(forward ? 0 : a.length-1); forward ? i<a.length : i>=0; forward ? i++ : i--){
					log.stack[log.stack.length-1] = i;
					if (Tester.deep_diff(a[i],b[i]))
						return log;
				}
				log.stack.pop();
				break;
			// object recursion
			case 1:
				/*if (Object.keys(a).length != Object.keys(b).length){
					log.msg = "object size differs";
					return log;
				}*/
				log.stack.push(null);
				for (let k in a){
					log.stack[log.stack.length-1] = k;
					if (!(k in b)){
						log.msg = "b missing a key";
						return log;
					}
					if (Tester.deep_diff(a[k], b[k]))
						return log;
				}
				log.stack.pop();
				break;
			// other
			case 2:
				if (a !== b){
					log.msg = "values differ";
					return log;
				}
				break;
		}
		return false;
	}
}

document.addEventListener("DOMContentLoaded", e => {
	const t = new Tester();
	let root = node();

	// test 1
	let [A,B,C] = nodes(3);
	root.append(A,B,C);
	t.start(root);
	root.append(A);
	root.prepend(C);
	root.prepend(B);
	t.stop();
	t.check_revert();


	const i = document.querySelector("body");
	let o = new MutationObserver((records) => {
		for (let r of records)
			console.log(r);
	});
	o.observe(i, {
		subtree: true,
		childList: true,
		attributes: true,
		// attributeFilter: allowed_attrs,
		attributeOldValue: true,
		characterData: true, 
		characterDataOldValue: true,
	});
	i.children[1].after(C);
	i.children[1].replaceWith(A,B,C);
});