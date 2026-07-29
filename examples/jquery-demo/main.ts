import $ from "jquery";

/**
 * Every interaction below is here to *execute* a name that one of the two
 * generated extern files pins. That is the point of the demo: if either extern
 * set regresses, this page throws in the browser instead of quietly rendering
 * a wrong-but-plausible result.
 *
 * The mapping from interaction to pinned name is noted at each block. Names in
 * `jquery.boundary.externs.js` are the app -> library ABI; names in
 * `jquery.runtime.externs.js` are jQuery's own internal hazards, which only
 * appear once the corresponding jQuery subsystem actually runs.
 */

// --------------------------------------------------------------------------
// Status toggle. Boundary names: hasClass, text, toggleClass, removeClass, on.
// --------------------------------------------------------------------------

const status = $("#status");
const toggleButton = $("#toggle-button");
const resetButton = $("#reset-button");

function renderStatus() {
  const isActive = status.hasClass("active");
  status.text(isActive ? "Active" : "Idle").toggleClass("active", isActive);
}

toggleButton.on("click", () => {
  status.toggleClass("active");
  renderStatus();
});

resetButton.on("click", () => {
  status.removeClass("active");
  renderStatus();
});

// --------------------------------------------------------------------------
// Item list. Ordinary breadth, so the boundary-aware set visibly grows:
// each, append, find, addClass, prop, val, delegated on(sel, handler), attr.
//
// The delegated handler is also what forces jQuery's event store to run, which
// is the `dataPriv.get(elem, "events")` read the runtime scan covers through
// `keyReadCallees` -- runtime names: events, handle, get, set, hasDataAttrs.
// --------------------------------------------------------------------------

const itemList = $("#item-list");
const itemInput = $("#item-input");
const addButton = $("#add-button");
const clearButton = $("#clear-button");
const filterInput = $("#filter-input");
const itemCount = $("#item-count");
const doneCount = $("#done-count");

let nextItemId = 1;

function refreshCounts() {
  const total = itemList.find("li").length;
  const done = itemList.find("li.done").length;
  itemCount.text(String(total));
  doneCount.text(String(done));
  // `.prop()` on a real form control, and `.attr()` for a reflected attribute.
  clearButton.prop("disabled", total === 0);
  itemList.attr("data-empty", total === 0 ? "true" : "false");
}

function addItem(label: string) {
  const id = nextItemId;
  nextItemId += 1;

  const item = $("<li></li>")
    .addClass("item")
    .attr("data-item-id", String(id))
    // `.data()` writes through jQuery's string-keyed private store; the read
    // below goes back through the same protocol.
    .data("itemId", id)
    .append($("<span></span>").addClass("item-label").text(label))
    .append(
      $("<button></button>")
        .addClass("item-toggle")
        .attr("type", "button")
        .text("Done"),
    );

  itemList.append(item);
  refreshCounts();
}

// Delegated click: one handler on the list, matched by selector. This is the
// path that exercises jQuery's internal event map rather than a direct bind.
itemList.on("click", ".item-toggle", function (this: HTMLElement) {
  const row = $(this).closest("li");
  row.toggleClass("done");
  // Read back what `.data()` stored -- proves the private store round-trips
  // with its literal key names intact.
  const storedId = row.data("itemId") as number | undefined;
  if (storedId !== undefined) {
    row.find(".item-label").attr("title", `item #${storedId}`);
  }
  refreshCounts();
});

addButton.on("click", () => {
  const value = String(itemInput.val() ?? "").trim();
  if (value.length === 0) {
    return;
  }
  addItem(value);
  itemInput.val("");
});

itemInput.on("keydown", (event) => {
  if (event.key === "Enter") {
    addButton.trigger("click");
  }
});

// `.each()` over a live collection, with `.css()` driving the inline style
// pathway -- runtime names: display, marginLeft.
filterInput.on("input", () => {
  const needle = String(filterInput.val() ?? "")
    .trim()
    .toLowerCase();
  itemList.find("li").each(function (this: HTMLElement) {
    const row = $(this);
    const label = row.find(".item-label").text().toLowerCase();
    const matches = needle.length === 0 || label.includes(needle);
    row.css("display", matches ? "" : "none");
  });
});

clearButton.on("click", () => {
  itemList.find("li").remove();
  filterInput.val("");
  refreshCounts();
});

// --------------------------------------------------------------------------
// Deferred / promise flow. This is the block that drives the constructed-key
// members the runtime externs pin: jQuery builds `resolveWith` / `rejectWith`
// / `notifyWith` as `deferred[tuple[0] + "With"] = list.fireWith`, a key
// Closure cannot see, and then reads them back with a plain dot.
//
// Runtime names: resolveWith, rejectWith, notifyWith, fireWith, catch.
//
// Deliberately no network and no $.ajax: a setTimeout-backed Deferred is
// deterministic, so the browser sweep can assert completion.
// --------------------------------------------------------------------------

const loadButton = $("#load-button");
const failButton = $("#fail-button");
const loadResult = $("#load-result");
const loadLog = $("#load-log");

function logLine(text: string) {
  loadLog.append($("<li></li>").text(text));
}

/** A resolved-after-`delay` promise built from a real jQuery Deferred. */
function delayedValue(label: string, delay: number) {
  const deferred = $.Deferred<string>();
  window.setTimeout(() => {
    deferred.resolve(label);
  }, delay);
  return deferred.promise();
}

function delayedFailure(reason: string, delay: number) {
  const deferred = $.Deferred<string>();
  window.setTimeout(() => {
    deferred.reject(reason);
  }, delay);
  return deferred.promise();
}

loadButton.on("click", () => {
  loadButton.prop("disabled", true);
  loadResult.text("Loading...").removeClass("ok failed");
  loadLog.find("li").remove();

  // `$.when` over two Deferreds: joins through the same fireWith machinery.
  $.when(delayedValue("alpha", 120), delayedValue("beta", 220))
    .done((first: string, second: string) => {
      logLine(`done: ${first} + ${second}`);
      loadResult.text(`Loaded ${first} + ${second}`).addClass("ok");
      addItem(`${first}-${second}`);
    })
    .fail(() => {
      logLine("fail: unexpected");
      loadResult.text("Load failed").addClass("failed");
    })
    .always(() => {
      logLine("always: settled");
      loadButton.prop("disabled", false);
      loadResult.attr("data-settled", "true");
    });
});

failButton.on("click", () => {
  failButton.prop("disabled", true);
  loadResult.text("Loading...").removeClass("ok failed");
  loadLog.find("li").remove();

  delayedFailure("boom", 120)
    .done(() => {
      logLine("done: unexpected");
    })
    .fail((reason: string) => {
      logLine(`fail: ${reason}`);
      loadResult.text(`Rejected (${reason})`).addClass("failed");
    })
    .always(() => {
      logLine("always: settled");
      failButton.prop("disabled", false);
      loadResult.attr("data-settled", "true");
    });
});

// --------------------------------------------------------------------------
// Effects. jQuery's fx engine is what allocates `_queueHooks`, walks `dequeue`
// and stashes the pre-animation `display` in `fxshow` -- all pinned runtime
// names that stay dormant until an animation actually runs.
//
// Runtime names: _queueHooks, dequeue, fxshow, display, height.
// --------------------------------------------------------------------------

const panel = $("#fx-panel");
const animateButton = $("#animate-button");
const fadeButton = $("#fade-button");
const fxState = $("#fx-state");

/**
 * Both buttons push onto the *same* fx queue, so they have to share one
 * lock: starting a fade midway through the animate chain otherwise interleaves
 * their completion callbacks and the panel never settles. `.stop(true, true)`
 * clears any leftover queue before starting.
 *
 * `.finish()` would do the same job, but it is one of the names runtime-aware
 * already pins as a jQuery *internal* hazard -- calling it from the app would
 * put the same name in both extern files and trip the disjointness assertion in
 * build.mjs, which is exactly the signal that assertion exists to give.
 */
function runEffect(start: (done: () => void) => void) {
  if (fxState.attr("data-fx") === "running") {
    return;
  }
  animateButton.prop("disabled", true);
  fadeButton.prop("disabled", true);
  fxState.attr("data-fx", "running");
  panel.stop(true, true);

  start(() => {
    panel.removeClass("busy");
    fxState.text("idle").attr("data-fx", "done");
    animateButton.prop("disabled", false);
    fadeButton.prop("disabled", false);
  });
}

animateButton.on("click", () => {
  runEffect((done) => {
    fxState.text("animating");
    panel
      // `.queue()` puts a bare callback on the same fx queue jQuery uses, so
      // the queue hooks are exercised even before the tween starts.
      .queue((next) => {
        panel.addClass("busy");
        next();
      })
      .animate({ opacity: 0.35, marginLeft: 24 }, 160)
      .animate({ opacity: 1, marginLeft: 0 }, 160)
      .queue((next) => {
        done();
        next();
      });
  });
});

fadeButton.on("click", () => {
  runEffect((done) => {
    fxState.text("fading");
    // fadeOut stashes the computed `display` in the element's `fxshow` state
    // and restores it on fadeIn; that round-trip is the pinned pair.
    panel.fadeOut(140, () => {
      panel.fadeIn(140, () => {
        done();
      });
    });
  });
});

// --------------------------------------------------------------------------
// Initial state.
// --------------------------------------------------------------------------

renderStatus();
addItem("first item");
addItem("second item");
refreshCounts();
