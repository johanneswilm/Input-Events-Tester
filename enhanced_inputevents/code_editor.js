/* Very simple example of a code editor that just has variables, operators, and integers;
	Mainly we're just handling insertText and insertCompositionText. For insertText, we assume
	any replacement range is enclosed in a single element. Deletes browser can handle. Other events
	will probably put the editor in an invalid state. It is mainly just demoing composition handling.
*/
import { setTextContent, emulate_composition_proposals } from "./emulate.js";

document.addEventListener("DOMContentLoaded", e => {
	const editor = document.getElementById("code_editor");	
	emulate_composition_proposals(editor);

	const whitespace = /\s/;
	const operators = /[-+*=()\[\]&|><^%?:;,.]/;
	const integers = /\d/;
	const variables = /[^-+*=()\[\]&|><^%?:;,.\d\s]/; // everything else
	// each token is wrapped in a span, with implicit compositionborder=true
	function new_token(text, type){
		const t = document.createElement("span");
		setTextContent(t, text);
		t.className = type;
		return t;
	}

	let current_token = "variable";
	editor.replaceChildren(new_token("", current_token));

	editor.addEventListener("beforeinput", e => {
		const t = e.inputType;
		const data = e.working_data || e.data;
		let range = e.working_range || e.getTargetRanges()[0];
		// StaticRange -> Range
		if (range){
			const r = new Range();
			// need to preserve the starting zero-width space when doing the edit; hence, we clamp start to be >= 1
			r.setStart(range.startContainer, Math.max(1, range.startOffset))
			r.setEnd(range.endContainer, range.endContainer === range.startContainer ?
				Math.max(r.startOffset, range.endOffset) :
				range.endOffset);
			range = r;
		}
		let target = range?.commonAncestorContainer;
		if (target.nodeType == Node.TEXT_NODE)
			target = target.parentNode;
		let cursor = null, focus;

		// modify DOM ourselves for inserts
		if (t == "emulated_insertFromComposition" || t == "insertText"){
			e.preventDefault();
			// since we control DOM, we know range just edits a single text node;
			range.startContainer.replaceData(range.startOffset, range.endOffset-range.startOffset, data);
			cursor = range.startOffset + data.length;
		}

		// need to update syntax highlighting?
		let token_change = data && (
			current_token != "operator" && operators.test(data) ||
			current_token != "integer" && integers.test(data) ||
			current_token != "variable" && variables.test(data)
		);
		if (token_change){
			// wait until insertFromComposition to rebuild
			if (t == "insertCompositionText")
				e.requestCompositionEnd();
			else{
				const frag = document.createDocumentFragment();
				const txt = target.textContent;
				current_token = null;
				let builder = "";
				// Emit token
				function flush(){
					if (builder){
						const token = new_token(builder, current_token);
						if (focus && focus[0] === null)
							focus[0] = token.firstChild;
						frag.appendChild(token);
					}
					builder = "";
				}
				// Simple text parser, while simultaneously building new DOM and finding new cursor position;
				// first character is the zero-width space
				for (let i=1; i<txt.length; i++){
					const c = txt.charAt(i);
					const type = 
						(whitespace.test(c) ? current_token || "variable" :
						integers.test(c) ? "integer" :
						operators.test(c) ? "operator" : "variable");
					if (type != current_token){
						flush();
						current_token = type;
					}
					if (i == cursor)
						focus = [null, builder.length];
					builder += c;
				}
				if (!focus)
					focus = [null, builder.length];
				flush();
				// commit the rebuilt DOM
				target.replaceWith(frag);
			}
		}
		else focus = [target.firstChild, cursor-1];
		// update selection;
		// add one to offset for zero-width space
		if (cursor !== null)
			window.getSelection().collapse(focus[0], focus[1]+1);
	});

});