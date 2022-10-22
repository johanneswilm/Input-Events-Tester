"use strict";
import { serialize } from "./serialize.js";

// DOM els
var divs,	// contenteditable test cases
	output, // log output element
	regex, 	// cancel beforeinput inputType regex
	limit,	// log message limit input
	cancel,	// cancel beforeinput checkbox
	freeze;	// freeze log

document.addEventListener("DOMContentLoaded", () => {
	divs = document.querySelectorAll("div[contenteditable]");
	output = document.querySelector("output");
	freeze = document.getElementById("freeze");
	cancel = document.getElementById("cancel");
	limit = document.getElementById("limit");
	regex = document.getElementById("regex");

	// Initialize
	document.addEventListener("selectionchange", (e) => {
		let div = document.activeElement;
		if (div.contentEditable == "true")
			serialize_current(div);
		log(`<b>${e.type}</b>`);
	});
	divs.forEach(div => {
		// setup serialization
		trim_whitespace(div);
		div.after(document.createElement("pre"));
		serialize_current(div);

		// events
		div.addEventListener("compositionstart", evt_msg);
		div.addEventListener("compositionupdate", evt_msg);
		div.addEventListener("compositionend", evt_msg);
		div.addEventListener("beforeinput", e => {
			let cancel_attempted = false;
			if (cancel.checked && (new RegExp(regex.value)).test(e.inputType)){
				cancel_attempted = true;
				e.preventDefault();
			}
			evt_msg(e, cancel_attempted);
		});
		div.addEventListener("input", evt_msg);
	});

});

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

// Create a message for event and log it
function evt_msg(e, cancel_attempted){
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
		else li.textContent += JSON.stringify(v);
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
    attr('defaultPrevented', [e.defaultPrevented, cancel_attempted ? "attempted" : "not attempted"]);
    attr('cancelable', e.cancelable);
    attr('timeStamp', e.timeStamp);
	if (e.getTargetRanges){
		let ranges = e.getTargetRanges();
		if (ranges.length){
			let pre = document.createElement("pre");
			serialize(e.target, pre, ranges);
			attr('ranges', pre);
		}
	}
    attr('selection', serialize_current(e.target).cloneNode(true));
	log(root);
}

// serialize div as it currently is
function serialize_current(div){
	const target = div.nextElementSibling;
	serialize(div, target, window.getSelection());
	return target;
}

// Keep a log of last N events, in reverse temporal order
function log(html) {
	if (freeze.checked)
		return;
	if (typeof html === "string"){
		const cont = document.createElement("div");
		cont.innerHTML = html;
		html = cont;
	}
	output.prepend(html);
	while (output.children.length > limit.valueAsNumber)
        output.lastElementChild.remove();
}