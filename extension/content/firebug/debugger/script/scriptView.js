/* See license.txt for terms of usage */

// ********************************************************************************************* //
// Module

define([
    "firebug/lib/trace",
    "firebug/lib/object",
    "firebug/lib/dom",
    "firebug/chrome/menu",
],
function (FBTrace, Obj, Dom, Menu) {

// ********************************************************************************************* //
// Constants

var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

// Introduced in Firefox 8
// We might want to switch to CodeMirror:
// Bug 816756 - CodeMirror as an alternative to Orion
// Issue 5353: please integrate Codemirror2 instead of Orion editor
Cu["import"]("resource:///modules/source-editor.jsm");

var Trace = FBTrace.to("DBG_SCRIPTVIEW");
var TraceError = FBTrace.to("DBG_ERRORS");

// ********************************************************************************************* //
// Source View

function ScriptView()
{
    this.editor = null;
    this.skipEditorBreakpointChange = false;
}

/**
 * ScriptView wraps SourceEditor component that is built on top of Orion editor.
 * This object is responsible for displaying JS source code in the debugger panel.
 */
ScriptView.prototype = Obj.extend(new Firebug.EventSource(),
/** @lends ScriptView */
{
    dispatchName: "ScriptView",
    initialized: false,
    initializeExecuted: false,

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Initialization

    initialize: function(parentNode)
    {
        if (this.initializeExecuted)
            return;

        this.initializeExecuted = true;

        Trace.sysout("scriptView.initialize; " + parentNode);

        this.onContextMenuListener = this.onContextMenu.bind(this);
        this.onBreakpointChangeListener = this.onBreakpointChange.bind(this);

        var config = {
            mode: SourceEditor.MODES.JAVASCRIPT,
            showLineNumbers: true,
            readOnly: true,
            showAnnotationRuler: true,
            showOverviewRuler: true,
            theme: "chrome://firebug/skin/orion-firebug.css",
        };

        this.editor = new SourceEditor();
        this.editor.init(parentNode, config, this.onEditorLoad.bind(this));

        // xxxHonza: use CSS?
        this.editor._iframe.style.width = "100%";
        this.editor._iframe.style.height = "100%";
    },

    onEditorLoad: function()
    {
        Trace.sysout("scriptView.onEditorLoad;", this.defaultSource);

        this.initialized = true;

        // Add editor listeners
        this.editor.addEventListener(SourceEditor.EVENTS.CONTEXT_MENU,
            this.onContextMenuListener);
        this.editor.addEventListener(SourceEditor.EVENTS.BREAKPOINT_CHANGE,
            this.onBreakpointChangeListener);

        // Focus so, keyboard works as expected.
        this.editor.focus();

        if (this.defaultSource)
            this.showSource(this.defaultSource);

        this.initBreakpoints();
    },

    destroy: function()
    {
        Trace.sysout("scriptView.destroy; " + this.initialized);

        this.editor.addEventListener(SourceEditor.EVENTS.CONTEXT_MENU,
            this.onContextMenuListener);
        this.editor.addEventListener(SourceEditor.EVENTS.BREAKPOINT_CHANGE,
            this.onBreakpointChangeListener);

        if (this.initialized)
            this.editor.destroy();

        this.editor = null;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Public API

    showSource: function(source)
    {
        Trace.sysout("scriptView.showSource; initialized: " + this.initialized, source);

        if (!this.initialized)
        {
            this.defaultSource = source;
            return;
        }

        var text = this.editor.getText();
        if (text == source)
            return;

        this.editor.setText(source);

        // Breakpoints and annotations in general must be set again after setText.
        this.initBreakpoints();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Context Menu

    onContextMenu: function(event)
    {
        var popup = document.getElementById("fbScriptViewPopup");
        Dom.eraseNode(popup);

        var browserWindow = Firebug.chrome.window;
        var commandDispatcher = browserWindow.document.commandDispatcher;

        var items = [];
        this.dispatch("onContextMenu", [items]);

        for (var i=0; i<items.length; i++)
            Menu.createMenuItem(popup, items[i]);

        if (!popup.childNodes.length)
            return;

        popup.openPopupAtScreen(event.screenX, event.screenY, true);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Search

    search: function(text, reverse)
    {
        var curDoc = this.searchCurrentDoc(!Firebug.searchGlobal, text, reverse);
        if (!curDoc && Firebug.searchGlobal)
        {
            return this.searchOtherDocs(text, reverse) ||
                this.searchCurrentDoc(true, text, reverse);
        }
        return curDoc;
    },

    searchOtherDocs: function(text, reverse)
    {
        var scanRE = Firebug.Search.getTestingRegex(text);

        var self = this;

        function scanDoc(compilationUnit)
        {
            var lines = null;

            // TODO The source lines arrive asynchronous in general
            compilationUnit.getSourceLines(-1, -1, function loadSource(unit, firstLineNumber,
                lastLineNumber, linesRead)
            {
                lines = linesRead;
            });

            if (!lines)
                return;

            // We don't care about reverse here as we are just looking for existence.
            // If we do have a result, we will handle the reverse logic on display.
            for (var i = 0; i < lines.length; i++)
            {
                if (scanRE.test(lines[i]))
                    return true;
            }
        }

        if (this.dispatch("onNavigateToNextDocument", [scanDoc, reverse]))
            return this.searchCurrentDoc(true, text, reverse) && "wraparound";
    },

    searchCurrentDoc: function(wrapSearch, text, reverse)
    {
        var options =
        {
            ignoreCase: !Firebug.Search.isCaseSensitive(text),
            backwards: reverse
        };

        if (this.currentSearch && text == this.currentSearch.text)
        {
            options.start = this.currentSearch.start;
            if (reverse)
                options.start -= text.length + 1;
        }
        else
        {
            this.currentSearch = {text: text, start: 0};
        }

        var offset = this.editor.find(text, options);
        Trace.sysout("search", {options: options, offset: offset});

        if (offset != -1)
        {
            this.editor.setSelection(offset, offset + text.length);
            this.currentSearch.start = offset + text.length;
            return true;
        }

        return false;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Breakpoints

    initBreakpoints: function()
    {
        var bps = [];
        this.dispatch("getBreakpoints", [bps]);

        if (!bps.length)
            return;

        // Ignore events about breakpoint changes.
        this.skipEditorBreakpointChange = true;

        for (var i=0; i<bps.length; i++)
        {
            var bp = bps[i];
            this.editor.addBreakpoint(bp.lineNo - 1);
        }

        this.skipEditorBreakpointChange = false;
    },

    onBreakpointChange: function(event)
    {
        if (this.skipEditorBreakpointChange)
            return;

        event.added.forEach(function(bp) {
            this.dispatch("addBreakpoint", [bp]);
        }, this);

        event.removed.forEach(function(bp) {
            this.dispatch("removeBreakpoint", [bp]);
        }, this);
    },

    removeBreakpoint: function(bp)
    {
        this.editor.removeBreakpoint(bp.lineNo - 1);
    },

    addBreakpoint: function(bp)
    {
        this.editor.addBreakpoint(bp.lineNo - 1);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Highlight Line

    scrollToLine: function(href, lineNo, highlighter)
    {
        //@hack xxxHonza: avoid exception
        if (!this.editor || !this.editor._model)
            return;

        this.editor.setDebugLocation(lineNo - 1);
        this.editor.setCaretPosition(lineNo - 1);
    },

    removeDebugLocation: function()
    {
        //@hack xxxHonza: avoid exception
        if (!this.editor || !this.editor._model)
            return;

        this.editor.setDebugLocation(-1);
    }
});

// ********************************************************************************************* //
// Export

return ScriptView;

// ********************************************************************************************* //
});