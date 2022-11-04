import { MutatedRange } from "./mutated_range.js";
import { MutationTracker } from "./mutation_tracker.js";
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
		if (node.nodeType instanceof CharacterData){
			this.attrs.data = node.data;
			if (node.childNodes.length)
				throw Error("assertion: CharacterData should not have children");
		}
		else{
			if (node.getAttribute?.constructor === Function){
				for (let k of allowed_attrs)
					this.attrs[k] = node.getAttribute(k);
			}
			for (let c of node.childNodes)
				this.children.push(new CachedDOM(c));
		}
	}
	/** Check for differences with another CachedDOM
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
	#diff_rec(other, forward, stack){
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
			let msg = a.#diff_rec(b, forward, stack);
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
		this.mutated = this.tracker.mutated(this.root);
		this.range = this.tracker.range(this.root);
		this.tracker.revert();
		this.dom_reverted = new CachedDOM(this.root);
		// check mutated
		let fdiff = this.dom_original.diff(this.dom_mutated);
		if (this.mutated != !!fdiff){
			console.error(fdiff);
			throw Error("mutated incorrect");
		}
		if (this.mutated != !!this.range){
			console.error(this.range);
			throw Error("range doesn't correspond with mutated");
		}
		// check range has correct bounds
		if (this.range){
			let bdiff = this.dom_original.diff(this.dom_mutated, false);
			// convert diff to an equivalent range
			if (fdiff.length <= 1 || bdiff.length <= 1)
				throw Error("assertion: root has been modified");
			// build a range from the diff results
			let mr = new MutatedRange();
			let sel = fdiff.at(-2).a;
			let sidx = fdiff.at(-1).index;
			if (!sidx)
				mr.setStart(sel.node, false);
			else mr.setStart(sel.children[sidx-1].node, true);
			let eel = bdiff.at(-2).a;
			let eidx = bdiff.at(-1).index;
			if (eidx >= eel.children.length-1)
				mr.setEnd(eel.node, false);
			else mr.setEnd(eel.children[eidx+1].node, true);
			// compare range
			if (!mr.isEqual(this.range)){
				console.error("reported:", this.range);
				console.error("actual:", mr);
				console.error("fdiff:", fdiff);
				console.error("fbiff:", bdiff);
				console.error("range is not correct");
			}
		}
		// check revert
		let rdiff = this.dom_original.diff(this.dom_reverted);
		if (rdiff){
			console.error(rdiff);
			throw Error("revert failed");
		}
		console.log("tests passed")
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
});