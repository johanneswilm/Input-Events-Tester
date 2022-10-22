/** Serialize html with some extra features:
 * 	- nodes are tracked and receive a unique id, and for elements, a color
 * 	- a Selection or list of Ranges can be rendered
 * 	- output selectors:
 * 		- span.tag: opening/closing carets and tagname of element; element's color is set as an inline style
 * 		- span.tag_attr: inline attributes for an element
 * 		- span.text: text node; unstyled span's are nested with the text content
 * 		- span[data-sid]: for .tag/.text nodes, this holds unique id for the node
 * 		- span[data-range=start/end/collapsed]: selection/range anchor, may be nested inside span.text
 * 		- span[data-rid]: for selection/range anchor, it indicates the range index
 * 
 * To use, create an anonymous object: new HTMLSerialize(options)
 */
export class HTMLSerialize {
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
	 * @param {Selection | [Range] | [StaticRange]} ranges specifies anchors to be rendered
	 */
    constructor(src, target, ranges = null){
		this.src = src;
		if (!HTMLSerialize.counter.has(src))
			HTMLSerialize.counter.set(src, {id: 0, hue: 0});
        this.frag = document.createDocumentFragment();
        this.serialize_recursive(src, ranges ? HTMLSerialize.ranges2anchors(ranges) : null, true);
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

	/**
	 * @param el element to serialize, as well as children/siblings
	 * @param anchors output of ranges2anchors
	 * @param skip if true, only render children and any anchors
	 */
    serialize_recursive(el, anchors, skip = false) {
        const istxt = el.nodeType == Node.TEXT_NODE;
		let hsl_main, hsl_attr, tag; // for rendering matching open/close tag when !istxt
		let a_locs = {};
		if (anchors && anchors.has(el)){
			a_locs = anchors.get(el);
			anchors.delete(el);
		}

		// render
		if ("before_open" in a_locs)
			a_locs["before_open"].forEach(this.add_anchor.bind(this));
        if (!skip) {
			this.assign_id(el);
            // text
            if (istxt){
				let txt = el.textContent;
				let root = this.add_span({clazz:"text", sid:el.serialization.id});
				if ("inside" in a_locs){
					let prev = 0;
					for (let c of a_locs["inside"]){
						if (prev != c.pos)
							this.add_span({txt:txt.substring(prev, c.pos), root});
						this.add_anchor(c, root);
						prev = c.pos;
					}
					txt = txt.substring(prev);
				}
				if (txt)
					this.add_span({txt, root});
			}
            // start tag
            else {
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
		if ("before_close" in a_locs)
			a_locs["before_close"].forEach(this.add_anchor.bind(this));
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
	add_anchor(anchor, root=null){
		const s = document.createElement("span");
		s.dataset.range = anchor.type;
		s.dataset.rid = anchor.id;
		(root || this.frag).appendChild(s);
	}

	/** CSS color definition from HSL numbers */
    static hsl(h, s = 100, l = 30) {
        return `color: hsl(${h},${s}%,${l}%);`;
    }
	/* Converts Selection, [StaticRange], or [Range] to Map in the form:
		el (element we should render the cursor in reference to) => {
			loc (before_open/before_close/inside) => [{
				id: integer index for which range this came from
				type: anchor type, start/end/collapsed
				pos: for "inside" loc's only, this indicates the position inside the text node
			}]
		}
		The locs list is sorted by id for before_open/before_close, and by pos for inside.
	*/
	static ranges2anchors(ranges){
		// Selection -> [Range]
		if (ranges instanceof Selection) {
			const convert = [];
			for (let i = 0; i < ranges.rangeCount; i++)
				convert.push(ranges.getRangeAt(i));
			ranges = convert;
		}
		let anchors = new Map();
		function classify_anchor(id, el, pos, type){
			// convert to our format
			let loc = "inside";
			if (el.nodeType != Node.TEXT_NODE){
				if (pos == el.childNodes.length)
					loc = "before_close";
				else{
					el = el.childNodes[pos];
					loc = "before_open";
				}		
			}
			// init structure
			let locs = anchors.get(el);
			if (!locs){
				locs = {};
				anchors.set(el, locs);
			}
			let lst = locs[loc];
			if (!lst){
				lst = [];
				locs[loc] = lst;
			}
			// save value
			const v = {id, type};
			if (loc === "inside")
				v.pos = pos;
			lst.push(v);
		}
		let id = 0;
		for (let r of ranges){
			classify_anchor(id, r.startContainer, r.startOffset, r.collapsed ? "collapsed" : "start");
			if (!r.collapsed)
				classify_anchor(id, r.endContainer, r.endOffset, "end");
			id++;
		}
		for (let locs of anchors.values()){
			if ("inside" in locs)
				locs["inside"].sort((a,b) => a.pos - b.pos);
		}
		return anchors;
	}
}

/** Renders src HTML to target, optionally marking ranges;
 *	See HTMLSerialize class for details
 */
export function serialize(src, target, ranges = null){
	new HTMLSerialize(src, target, ranges);
}