"use strict";
var output, divs, count, cancel;

document.addEventListener("DOMContentLoaded", () => {
	output = document.querySelector("output");
	divs = document.querySelectorAll("div");
	[count, cancel] = document.querySelectorAll("input");

	// Initialize
	document.addEventListener("selectionchange", (e) => {
		let div = document.activeElement;
		/* console.log(div); */
		if (div.contentEditable == "true")
			serialize_current(div);
		log(`<b>${e.type}</b>`);
	});
	divs.forEach((div, idx) => {
		// setup serialization
		trim_whitespace(div);
		div.after(document.createElement("pre"));
		serialize_current(div);

		// events
		div.addEventListener("compositionstart", evt_msg);
		div.addEventListener("compositionupdate", evt_msg);
		div.addEventListener("compositionend", evt_msg);
		div.addEventListener("beforeinput", e => {
			if (cancel.checked)
				e.preventDefault();
			evt_msg(e);
		});
		div.addEventListener("input", evt_msg);
	});

});

// Keep a log of last N events, in reverse temporal order
function log(html) {
	if (typeof html === "string"){
		const cont = document.createElement("div");
		cont.innerHTML = html;
		html = cont;
	}
	output.prepend(html);
	while (output.children.length > count.valueAsNumber)
        output.lastElementChild.remove();
}

// Print div's html with some extra coloring/labeling features
class HTMLSerialize {
	// divisions in hue, when rotating colors for next element
    static HUE_DIVS = 7;
	// attributes to serialize; {js attribute -> html attribute}
    static SHOW_ATTRS = {
        className: "class"
    };
	// singelton tags/eleemnts
    static SINGLETON = new Set(["br", "hr", "wbr", "col", "command", "img"]);
	// counter for unique ids and colors; {container -> {id/hue: int}
	static counter = new Map();

	/**
	 * @param src source element to serialize
	 * @param target where to render the serialization
	 * @param anchors output of ranges2anchors
	 */
    constructor(src, target, anchors = null){
		this.src = src;
		if (!HTMLSerialize.counter.has(src))
			HTMLSerialize.counter.set(src, {id: 0, hue: 0});
        this.frag = document.createDocumentFragment();
        this.serialize_recursive(src, anchors, true);
        target.replaceChildren(this.frag);
    }
	
	/** Give each node a unqiue id, and each element a hue. Can be used
		to indicate whether a node was recreated/destroyed
	*/
	assign_id(el){
		if (typeof el.serialization === "undefined"){
			let c = HTMLSerialize.counter.get(this.src);
			el.serialization = Object.assign({}, c);
			c.id++;
			if (el.nodeType == Node.ELEMENT_NODE)
				c.hue = (c.hue + 360 / (HTMLSerialize.HUE_DIVS + 0.5)) % 360;
		}
	}
	
	add_cursor(cursor, root=null){
		const s = document.createElement("span");
		s.dataset.range = cursor.type;
		(root || this.frag).appendChild(s);
	}

    serialize_recursive(el, anchors, skip = false) {
        const istxt = el.nodeType == Node.TEXT_NODE;
        let hsl_main, hsl_attr, tag;
		let cursors = anchors ? anchors.get(el) : null;
		if (cursors)
			cursors.filter(c => c.pos == "before_open").forEach(this.add_cursor.bind(this));
        if (!skip) {
			this.assign_id(el);
            // text
            if (istxt){
				let txt = el.textContent;
				let root = this.add_span({clazz:"text", sid:el.serialization.id});
				if (cursors){
					let split = cursors.filter(c => typeof c.pos !== "string");
					split.sort((a,b) => a.pos-b.pos);
					let prev = 0;
					for (let c of split){
						if (prev != c.pos)
							this.add_span({txt:txt.substring(prev, c.pos), root});
						this.add_cursor(c, root);
						prev = c.pos;
					}
					txt = txt.substring(prev);
				}
				if (txt)
					this.add_span({txt, root});
			}
            // start tag
            else {
                let h = this.next_hue();
                hsl_main = HTMLSerialize.hsl(el.serialization.hue);
                hsl_attr = HTMLSerialize.hsl(el.serialization.hue, 75, 50);
                tag = el.tagName.toLowerCase();
                this.add_span({txt:`<${tag}`, clazz:"tag", style:hsl_main, sid:el.serialization.id});
                // attributes whitelist
                for (let attr in HTMLSerialize.SHOW_ATTRS) {
                    if (el[attr])
                        this.add_span({txt:` ${HTMLSerialize.SHOW_ATTRS[attr]}='${el[attr]}'`, clazz:"tag_attr", style:hsl_attr});
                }
                this.add_span({txt:`>`, clazz:"tag", style:hsl_main});
            }
        }
        // children
        if (el.firstChild)
            this.serialize_recursive(el.firstChild, anchors);
		if (cursors)
			cursors.filter(c => c.pos == "before_close").forEach(this.add_cursor.bind(this));
        // end tag
        if (!skip && !istxt && !HTMLSerialize.SINGLETON.has(tag)){
			this.add_span({txt:`</${tag}`, clazz:"tag", style:hsl_main, sid:el.serialization.id});
			this.add_span({txt:`>`, clazz:"tag", style:hsl_main});
		}
        // siblings
        if (!skip && el.nextSibling)
            this.serialize_recursive(el.nextSibling, anchors);
    }

    add_span({txt=null, clazz=null, style=null, sid=null, root=null} = {}){
        const s = document.createElement("span");
		if (txt)
        	s.textContent = txt;
		if (clazz)
        	s.className = clazz;
		if (style)
        	s.style = style;
		if (sid !== null)
			s.dataset.sid = sid;
        (root || this.frag).appendChild(s);
		return s;
    }

    // To rotate colors for each element
    next_hue() {
        let h = this.cur_hue;
        
        return h;
    }
    static hsl(h, s = 100, l = 30) {
        return `color: hsl(${h},${s}%,${l}%);`;
    }
}

/* Converts Selection, [StaticRange], or [Range] to Map in the form:
	el => {
		el: element we should render the cursor in reference to
		type: start/end/collapsed
		pos: before_open/before_close, or an integer for text nodes indicating text offset
	}
*/
function ranges2anchors(ranges){
	// Selection -> [Range]
	if (ranges instanceof Selection) {
        const convert = [];
        for (let i = 0; i < ranges.rangeCount; i++)
            convert.push(ranges.getRangeAt(i));
        ranges = convert;
    }
	let anchors = new Map();
	function classify_anchor(el, pos, type){
		let obj = {el, type, pos};
		if (el.nodeType != Node.TEXT_NODE){
			if (pos == el.childNodes.length)
				obj.pos = "before_close";
			else{
				obj.el = el.childNodes[pos];
				obj.pos = "before_open";
			}		
		}
		if (!anchors.has(el))
			anchors.set(el, [obj]);
		else anchors.get(el).push(obj);
	}
	for (let r of ranges){
		classify_anchor(r.startContainer, r.startOffset, r.collapsed ? "collapsed" : "start");
		if (!r.collapsed)
			classify_anchor(r.endContainer, r.endOffset, "end");
	}
	return anchors;
}

// Create a message for event and log it
function evt_msg(e) {
    let etype = e.type;
    if (e.inputType)
        etype += "." + e.inputType;
	let root = document.createElement("div");
    root.innerHTML = `<b>${etype}:</b><ul></ul>`;
	let list = root.lastElementChild;
    const attr = (k, v) => {
		let li = document.createElement("li");
		li.textContent = `${k}: `;
		if (v?.nodeType == Node.ELEMENT_NODE)
			li.appendChild(v);
		else li.textContent += JSON.stringify([v]);
		list.appendChild(li);
	};
    if (e.dataTransfer instanceof DataTransfer) {
        attr('text/plain', e.dataTransfer.getData("text/plain"));
        attr('text/html', e.dataTransfer.getData("text/html"));
    }
    if (typeof e.data !== "undefined")
        attr('data', e.data);
    if (typeof e.isComposing === "boolean")
        attr('isComposing', e.isComposing);
    attr('defaultPrevented', e.defaultPrevented);
    attr('cancelable', e.cancelable);
    attr('timeStamp', e.timeStamp);
	if (e.getTargetRanges){
		let ranges = e.getTargetRanges();
		if (ranges.length){
			console.log(ranges);
			let pre = document.createElement("pre");
			let anchors = ranges2anchors(ranges);
			new HTMLSerialize(e.target, pre, anchors);
			attr('ranges', pre);
		}
	}
    attr('selection', serialize_current(e.target).cloneNode(true));
	log(root);
}

// trim whitespace/textnodes from start/end of element
function trim_whitespace(el) {
    const f = el.firstChild,
        l = el.lastChild;
    if (f.nodeType == Node.TEXT_NODE) {
        let d = f.data.trimStart();
		if (d) f.data = d;
		else f.remove();
    }
    if (l.nodeType == Node.TEXT_NODE && l.parentNode) {
        let d = l.data.trimEnd();
		if (d) l.data = d;
		else l.remove();
    }
}

function serialize_current(div){
	const sel = ranges2anchors(window.getSelection());
	new HTMLSerialize(div, div.nextElementSibling, sel);
	return div.nextElementSibling;
}
