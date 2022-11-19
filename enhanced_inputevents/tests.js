import { MutatedRange } from "./mutated_range.js";
import { MutationDiff } from "./mutation_diff.js";
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
		if (node instanceof CharacterData){
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
		const delta = forward ? 1 : -1;
		let ai = forward ? 0 : this.children.length-1;
		let bi = forward ? 0 : other.children.length-1;
		while (true){
			const a = this.children[ai];
			const b = other.children[bi];
			if (!a && !b) break;
			stack.push({a,b,ai,bi});
			if (!a)
				return "a is missing a child node";
			if (!b)
				return "b is missing a child node";
			let msg = a.#diff_rec(b, forward, stack);
			if (msg)
				return msg;
			stack.pop();
			ai += delta;
			bi += delta;
		}
	}
	pretty_print(tabs=0){
		let str = "";
		function add_tabs(){
			for (let i=0; i<tabs; i++)
				str += "   ";
		}
		add_tabs();		
		if (this.node.nodeType === Node.TEXT_NODE)
			str += `#${this.attrs.data}`;
		else{
			let tag = this.node.tagName.toLowerCase()+this.node.uid;
			str += `<${tag}`;
			for (let [k,v] of Object.entries(this.attrs)){
				if (v !== null)
					str += ` ${k}='${v}'`;
			}
			str += '>';
			if (this.children.length){
				str += '\n';
				for (let child of this.children)
					str += child.pretty_print(tabs+1)+'\n';
				add_tabs();
			}
			str += `</${tag}>`;
		}
		return str;
	}
}

/** Helper class to run tests
 * - Use `start` to start tracking a DOM, and `stop` when mutations are finished.
 * - Use `check_revert` to revert the DOM and check that it performed correctly;
 *		If failed, dom_[original, mutated, reverted], range, and mutated can be examined
 */
class Tester{
	constructor(verbose=false){
		this.verbose = verbose;
		this.dom_original = null;
		this.tracker = new MutationDiff();
		this.observer = new MutationObserver(this.record.bind(this, null));
	}
	record(records){
		for (let r of records){
			// console.log(r);
			this.tracker.record(r);
		}
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
		this.verbose && console.log("starting, original:\n", this.dom_original.pretty_print());
	}
	/** Start tracking/observing previously set root */
	stop(){
		this.record(this.observer.takeRecords());
		this.observer.disconnect();
	}
	/** Try reverting and see if it works */
	check_revert(name){
		this.dom_mutated = new CachedDOM(this.root);
		this.verbose && console.log("stopping, mutated:\n", this.dom_mutated.pretty_print());
		this.mutated = this.tracker.mutated(this.root);
		this.range = this.tracker.range(this.root);
		this.tracker.revert();
		this.dom_reverted = new CachedDOM(this.root);
		this.verbose && console.log("stopped, reverted:\n", this.dom_reverted.pretty_print());
		// check mutated
		if (true){
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
				// TODO: range calculation is incorrect, debug
				let mr = new MutatedRange();
				let sel = fdiff.at(-2).a;
				let sidx = fdiff.at(-1).ai;
				if (!sidx)
					mr.setStart(sel.node, false);
				else mr.setStart(sel.children[sidx-1].node, true);
				let eel = bdiff.at(-2).a;
				let eidx = bdiff.at(-1).ai;
				if (eidx >= eel.children.length-1)
					mr.setEnd(eel.node, false);
				else mr.setEnd(eel.children[eidx+1].node, true);
				// compare range
				if (!mr.isEqual(this.range)){
					console.error("reported:", this.range);
					console.error("actual:", mr);
					console.error("fdiff:", fdiff);
					console.error("fbiff:", bdiff);
					throw Error("range is incorrect");
				}
			}
		}
		// check revert
		let rdiff = this.dom_original.diff(this.dom_reverted);
		if (rdiff){
			console.error(rdiff);
			throw Error("revert failed");
		}
		console.log(`test ${name} passed`)
	}
}


// For reproducible randomized tests:
// copied from here: https://stackoverflow.com/questions/521295
const seed = cyrb128("mutations");
const random = xoshiro128ss(...seed);
function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277,
        h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
        k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1^h2^h3^h4)>>>0, (h2^h1)>>>0, (h3^h1)>>>0, (h4^h1)>>>0];
}
function xoshiro128ss(a, b, c, d) {
    const gen = () => {
        var t = b << 9, r = a * 5; r = (r << 7 | r >>> 25) * 9;
        c ^= a; d ^= b;
        b ^= c; a ^= d; c ^= t;
        d = d << 11 | d >>> 21;
        return (r >>> 0) / 4294967296;
    };
	gen.getSeed = () => [a,b,c,d];
	// set seed from four ints, an array of four ints, or a string
	const setSeed = gen.setSeed = (na, nb, nc, nd) => {
		if (Array.isArray(na))
			[a,b,c,d] = na;
		else if (typeof na === "string")
			[a,b,c,d] = cyrb128(na);
		else{
			a = na;
			b = nb;
			c = nc;
			d = nd;
		}
	}
	gen.randomSeed = () => setSeed(String(Math.random()));
	return gen;
}

/** Generates a random DOM tree, randomly mutates the DOM, and then tests if mutations/range 
 * 	were tracked correctly
 * @param sample_count how many random tests to do
 * @param element_count how many elements to generate
 * @param text_count how many text nodes to generate; recommended > element_count
 * @param data_count how many possible text string contents there are
 * @param init_op_count how many node ops to perform to initialize the DOM; a random DOM
 * 	is generated to start, so this could be set to zero; but adding init ops can yield some
 * 	orphaned nodes
 * @param op_count how many node ops to perform as mutations on the initialized DOM
 * @param insert_max max number of nodes to insert in a single operation
 * @param prop_chance [0,1] probability we will modify a property; otherwe we do a node operation
 * @param verbose verbose logging
 */
function randomized_tests({
	sample_count, element_count, text_count, data_count, init_op_count,
	op_count, insert_max, prop_chance, verbose
}){
	// random integer, max is exclusive
	function random_int(max){ return Math.floor(random()*max); }
	// random text data
	function random_data(){ return String(random_int(data_count)); }
	function set_data(txt, val){
		txt.data = `txt${txt.uid}-${val}`;
	}
	// random array value
	function random_val(arr){ return arr[random_int(arr.length)]; }
	// in-palace shuffle array
	function shuffle(a){
		for (let i = a.length - 1; i > 0; i--) {
			const j = random_int(i+1);
			const x = a[i];
			a[i] = a[j];
			a[j] = x;
		}
	}
	// sample from an array without replacement
	function* sample(a){
		for (let i = a.length - 1; i >= 0; i--) {
			const j = random_int(i+1);
			if (i != j){
				const x = a[i];
				a[i] = a[j];
				a[j] = x;
			}
			yield a[i];
		}
	}
	// create nodes; don't use randomness here, so that each test can be reproducible by
	// setting random seed to what it was at the start of the test
	const root = node();
	const els = nodes(element_count);
	const txts = [];
	while (txts.length != text_count)
		txts.push(text("0"));
	const merged = [...els, ...txts];
	// DOM tree ops:
	// element or text that is not its own root: remove-0, replaceWith-1, before-2, after-3
	// elment only: replaceChildren-4, prepend-5, append-6
	const ops = ["remove","replaceWith","before","after","replaceChildren","prepend","append"];
	// begin tests
	function log_full(name){
		if (!verbose)
			return;
		console.log(`#${name} {`);
		let roots = new Set([root]);
		for (let m of merged)
			roots.add(m.getRootNode());
		for (let r of roots)
			console.log((new CachedDOM(r)).pretty_print(1))
		console.log("}")
	}
	let test = new Tester(verbose);
	for (let iter=0; iter<sample_count; iter++){
		const seed = random.getSeed()
		verbose && console.log(`random test sample ${iter}, seed:`, seed);
		// reset DOM
		for (let m of merged){
			m.remove();
			if (m.nodeType === Node.TEXT_NODE)
				set_data(m, 0);
			else m.removeAttribute("class");
		}
		const shuffled = Array.from(merged);
		// initialize DOM; randomly insert into root
		root.replaceChildren();
		shuffle(shuffled);
		let avail = [root];
		for (let m of shuffled){
			random_val(avail).append(m);
			if (m.nodeType != Node.TEXT_NODE)
				avail.push(m);
			// random text
			else set_data(m, random_data());
		}
		// random mutations
		try{
			let started = false;
			for (let i=0; i<init_op_count+op_count; i++){
				if (i == init_op_count){
					started = true;
					test.start(root);
					log_full("start");
				}
				let p = random();
				// modify property
				if (p <= prop_chance){
					const node = random_val(shuffled);
					if (node.nodeType == Node.TEXT_NODE)
						set_data(node, random_data());
					else node.setAttribute("class", "x"+random_data());
					verbose && started && console.log("prop", node);
				}
				// modify DOM tree
				else{
					const op = random_int(7);
					const insert = [];
					let node = null;
					if (op <= 3){
						for (const n of sample(shuffled)){
							if (n.getRootNode() !== n){
								node = n;
								break;
							}
						}
					}
					else{
						let idx = random_int(els.length+1);
						node = !idx ? root : els[idx-1];
					}
					if (node === null)
						continue;
					// gather a list of nodes to insert with this op
					if (op){
						// operation cannot operate on any ancestor
						const ancestors = new Set();
						// and these ops specifically can't work on themselves
						if (op > 3)
							ancestors.add(node);
						let p = node;
						while (p = p.parentNode)
							ancestors.add(p);
						ancestors.delete(root);
						// draw samples
						const limit = Math.min(shuffled.length-ancestors.size, insert_max);
						const insert_count = random_int(limit+1);
						for (const n of sample(shuffled)){
							if (ancestors.has(n))
								continue;
							if (insert.push(n) >= insert_count)
								break;
						}
					}
					if (verbose && started)
						console.log(ops[op], node, insert);
					// perform op
					node[ops[op]](...insert);				
					if (verbose && started)
						log_full("op");
				}
			}
			log_full("stop");
			test.stop();
			test.check_revert(`random_sample_${iter}`);
			log_full("revert");
		} catch(err){
			console.error("Random test failed with seed:", seed);
			console.error(err);
			throw err;
		}
	}
}

document.addEventListener("DOMContentLoaded", e => {
	const t = new Tester();
	let root = node();
	let [A,B,C] = nodes(3);
	root.append(A,B,C);

	/*/ test 1
	t.start(root);
	root.append(A); // BCA
	root.prepend(C); // CBA
	root.prepend(B); // BCA
	t.stop();
	t.check_revert(1);
	//*/

	/*/ test 2
	t.start(root);
	root.append(A); // BCA
	root.append(B); // CAB
	root.append(C); // ABC
	t.stop();
	t.check_revert(2);
	//*/

	/*/ test 3
	t.start(root);
	root.append(A); // BCA
	root.append(B); // CAB
	C.remove(); // AB
	t.stop();
	t.check_revert(3);
	//*/

	//*
	
	random.setSeed(402117071, -1746714304, 1101306980, -1985325453);
	// random.randomSeed();
	randomized_tests({
		sample_count: 1,
		element_count: 4,
		text_count: 3,
		data_count: 3,
		init_op_count: 3,
		op_count: 4,
		insert_max: 3,
		prop_chance: .15,
		verbose: true
	})
	//*/
});