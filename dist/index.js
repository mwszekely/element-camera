/**
 * The goal is that we want have evenly-sized pixels,
 * so we want to round all our positions and scales.
 * But we can't just round to 1, because some monitors (etc.)
 * have higher ratios of "real" pixels to "math"(idk) pixels.
 *
 * This function is just "Math.round, but to the nearest
 * whole pixel instead of nearest whole number".
 *
 * If you want to test this in, say, Windows, set the
 * "Scale" option for the monitor to 150%. The unevenly-
 * sized pixels are super obvious at that size.
 */
export function roundByDevicePixels(x, step, op = Math.round) {
    let annoyingRatioThing = step / (("devicePixelRatio" in window ? window.devicePixelRatio : 1) ?? 1);
    return op(x / annoyingRatioThing) * annoyingRatioThing;
}
export class ElementCamera {
    element;
    parent;
    /**
     * The size of the child element that we're panning and zooming around.
     *
     * It's expected that these don't change throughout the lifetime of the class,
     * which is true in all cases right now. But this should probably be changed
     * in the future...
     */
    elementBaseWidth;
    elementBaseHeight;
    lastCommittedState;
    /**
     * The scale that's currently requested.
     *
     * We use this to handle "fine" scroll wheels,
     * like those on Mac devices, vs "coarse" scroll wheels,
     * like those on a normal mouse wheel.
     *
     */
    scaleRequested;
    /**
     * Where is the user currently focused on the child image?
     *
     * This is where zoom events will be relative to.
     */
    focusXP;
    focusYP;
    /**
     * The next time we update, how far should the image be panned?
     *
     * Should be a number of pixels relative to the unscaled child element.
     */
    panDeltaX;
    panDeltaY;
    /**
     * After zooming, these are used to ensure that the
     * focus position is reset correctly.
     *
     * For multi-touch zooming, this is the
     * center of all the touch events.
     *
     * These are "raw" values and usually shouldn't be used
     * directly. They are relative to screen-space, so besides
     * even needing to be scaled back down they also need
     * to be de-translated back.
     */
    pointerLastX = 0;
    pointerLastY = 0;
    usePointerLock = false;
    /**
     * Can be optionally set to round the final scale to the given interval.
     *
     * Used for hi-res mode mostly.
     */
    step = 1;
    // TODO: Make these real dispatched events as an `EventTarget`, I guess.
    onFocusChange = undefined;
    onScaleChange = undefined;
    onClick = undefined;
    constructor(element, initialStep = 1) {
        this.element = element;
        this.step = initialStep;
        try {
            document.addEventListener("pointerlockchange", this._onPointerLockChange);
            element.addEventListener("pointermove", this.onPointerMove);
            element.addEventListener("pointerdown", this.onPointerDown);
            element.addEventListener("pointerup", this.onPointerUp);
            element.addEventListener("wheel", this.zoomWithWheel);
            // TODO: REMOVE THIS
            window.addEventListener("resize", () => {
                let newScale = roundByDevicePixels(Math.max(1, (this.parent.offsetHeight / this.elementBaseHeight)), this.step, Math.floor);
                if (newScale > this.scaleRequested) {
                    this.scaleRequested = newScale;
                    this._recalculateImpl();
                }
            });
            this.parent = element.parentElement;
            this.elementBaseWidth = this.element.offsetWidth;
            this.elementBaseHeight = this.element.offsetHeight;
            let initialScale = roundByDevicePixels(Math.max(1, (this.parent.offsetHeight / this.elementBaseHeight)), this.step, Math.floor);
            this.scaleRequested = initialScale;
            this.lastCommittedState = {
                scaleUsed: initialScale,
                targetXP: 0.5,
                targetYP: 0.5,
                transformX: 0,
                transformY: 0
            };
            this.focusXP = this.lastCommittedState.targetXP;
            this.focusYP = this.lastCommittedState.targetYP;
            //this.pointerLastX = this.focusXP * this.elementBaseWidth * initialScale;
            //this.pointerLastY = this.focusYP * this.elementBaseHeight * initialScale;
            this.panDeltaX = this.panDeltaY = 0;
            this.scaleRequested = initialScale;
            this._recalculateImpl();
        }
        catch (ex) {
            console.error(ex);
            throw ex;
        }
    }
    ignoreMouseFocus = false;
    setPosition(centerX, centerY) {
        this.panDeltaX = (centerX - (this.lastCommittedState.targetXP * this.elementBaseWidth));
        this.panDeltaY = (centerY - (this.lastCommittedState.targetYP * this.elementBaseHeight));
        if (this.panDeltaX > 40)
            debugger;
        this._recalculateImpl();
        this.panDeltaX = this.panDeltaY = 0;
    }
    /** Returns the unscaled pixel coordinate that is currently being focused (e.g. hovered by the mouse) */
    get focusXPixel() { return Math.round(this.focusXP * this.elementBaseWidth); }
    get focusYPixel() { return Math.round(this.focusYP * this.elementBaseHeight); }
    pointerIsLocked = false;
    _onPointerLockChange = (e) => {
        this.pointerIsLocked = (document.pointerLockElement != null);
    };
    [Symbol.dispose]() {
        document.removeEventListener("pointerlockchange", this._onPointerLockChange);
        this.element.removeEventListener("pointermove", this.onPointerMove);
        this.element.removeEventListener("pointerdown", this.onPointerDown);
        this.element.removeEventListener("pointerup", this.onPointerUp);
        this.element.removeEventListener("wheel", this.zoomWithWheel);
    }
    /**
     * Used to determine if click events are allowed to run
     * after pointerup (i.e. if we move or zoom, there's
     * no click event.)
     */
    pannedOrZoomedDuringPointerDown = undefined;
    /**
     * This might need a refactor (already), it's kinda weird,
     * but it's basically what we're doing with the current pointer data.
     *
     * * `null`: No pointer info, i.e. mouse buttons aren't down, not touching the screen, etc.
     * * `pending`: Mouse button is down or touching, but we don't know if this is a pan or zoom yet.
     * * `pan`/`zoom`: We are doing one of these two operations
     *
     * It's possible to want to pan while zooming, which should be possible, but
     * isn't with this set-up. It doesn't feel like a huge deal right now, though.
     */
    pointerAction = null;
    /**
     * Keep track of the pointer data we have.
     *
     * For mouse-like pointers, this will always only have a single entry.
     *
     * For touch-like pointers, it will have multiple during zoom gestures, but one otherwise.
     */
    pointerData = new Map();
    /**
     * We just need some extra state for pinch-zooming to work,
     * so here it is, isolated from the rest of the class state.
     */
    pinchZoomStuff = { centerX: 0, centerY: 0, initialDistance: 0, currentDistance: 0, initialScaleRequested: 1 };
    _firstMoveAfterPointerLockThatShouldBeIgnored = false;
    onPointerDown(e) {
        this.pannedOrZoomedDuringPointerDown = false;
        if (e.button == 0 && e.pointerType != 'touch') {
            this.onClick?.(e, this.focusXPixel, this.focusYPixel);
            e.preventDefault();
            e.stopPropagation();
        }
        else if (e.button == 1 || e.button == 2 || (e.button == 0 && e.pointerType == 'touch')) {
            e.preventDefault();
            e.stopPropagation();
            this.usePointerLock = ((e.button == 1 || e.button == 2) && e.pointerType == 'mouse');
            this.parent.setPointerCapture(e.pointerId);
            this.pointerAction = 'pending';
            this.pointerData.set(e.pointerId, { startX: e.x, startY: e.y, currentX: e.x, currentY: e.y });
        }
        if (this.pointerData.size > 1) {
            let cx = 0;
            let cy = 0;
            for (const [pointerId, { startX: x, startY: y }] of this.pointerData) {
                cx += x;
                cy += y;
            }
            cx /= this.pointerData.size;
            cy /= this.pointerData.size;
            this.pinchZoomStuff.centerX = cx;
            this.pinchZoomStuff.centerY = cy;
            let initialDistance = 0;
            for (const [pointerId, { startX: x, startY: y }] of this.pointerData) {
                const x2 = (x - cx) * (x - cx);
                const y2 = (y - cy) * (y - cy);
                initialDistance += Math.sqrt(x2 + y2);
            }
            this.pinchZoomStuff.initialDistance = this.pinchZoomStuff.currentDistance = (initialDistance / this.pointerData.size);
            this.pinchZoomStuff.initialScaleRequested = this.scaleRequested;
        }
        this.pointerLastX = e.x;
        this.pointerLastY = e.y;
        const prevFocus = [this.focusXP, this.focusYP];
        this.focusXP = (this.pointerLastX - this.lastCommittedState.transformX) / this.lastCommittedState.scaleUsed / this.elementBaseWidth;
        this.focusYP = (this.pointerLastY - this.lastCommittedState.transformY) / this.lastCommittedState.scaleUsed / this.elementBaseHeight;
        this.onFocusChange?.(e, this.focusXPixel, this.focusYPixel);
        if (this.ignoreMouseFocus) {
            [this.focusXP, this.focusYP] = [...prevFocus];
        }
        this._debug();
    }
    _debug() {
        let element = document.getElementById("element-camera-debug-info");
        if (element)
            element.innerHTML = `SX: ${[...this.pointerData.values()][0]?.startX?.toString() ?? "-"}<br>SY: ${[...this.pointerData.values()][0]?.startY?.toString() ?? "-"}<br>CX: ${[...this.pointerData.values()][0]?.currentX?.toString() ?? "-"}<br>CY: ${[...this.pointerData.values()][0]?.currentY?.toString() ?? "-"}<br>PX: ${this.panDeltaX?.toString() ?? "-"}<br>PY: ${this.panDeltaY?.toString() ?? "-"}`;
    }
    onPointerUp(e) {
        if (this.pointerData.size > 0) {
            let didSomethingThatJustifiesCancellingTheEvent = false;
            if (this.pointerAction != null)
                didSomethingThatJustifiesCancellingTheEvent = true;
            this._debug();
            this.pointerData.delete(e.pointerId);
            if (this.pointerData.size == 0)
                this.pointerAction == null;
            if (this.usePointerLock && "exitPointerLock" in document)
                document.exitPointerLock();
            if (this.parent.hasPointerCapture(e.pointerId))
                this.parent.releasePointerCapture(e.pointerId);
            if (!this.pannedOrZoomedDuringPointerDown && (e.pointerType == 'touch' || e.button != 0)) {
                if (this.onClick) {
                    this.onClick(e, this.focusXPixel, this.focusYPixel);
                }
                //this._doClickInsteadOfPanningOrAnythingLikeThat(e);
            }
            this.pointerAction = null;
            this.panDeltaX = this.panDeltaY = 0;
            this.usePointerLock = false;
            const prevFocus = [this.focusXP, this.focusYP];
            this.focusXP = (this.pointerLastX - this.lastCommittedState.transformX) / this.lastCommittedState.scaleUsed / this.elementBaseWidth;
            this.focusYP = (this.pointerLastY - this.lastCommittedState.transformY) / this.lastCommittedState.scaleUsed / this.elementBaseHeight;
            this.onFocusChange?.(e, this.focusXPixel, this.focusYPixel);
            if (this.ignoreMouseFocus) {
                [this.focusXP, this.focusYP] = [...prevFocus];
            }
            if (didSomethingThatJustifiesCancellingTheEvent) {
                e.preventDefault();
                e.stopPropagation();
            }
        }
    }
    onPointerMove(e) {
        if (this.pointerAction == 'pending') {
            if (this.pointerData.size == 1) {
                this.pointerAction = 'pan';
                if (this.usePointerLock && "exitPointerLock" in document) {
                    this.parent.requestPointerLock({});
                    this._firstMoveAfterPointerLockThatShouldBeIgnored = true;
                }
            }
            else {
                this.pointerAction = 'zoom';
            }
        }
        let existingPointerData = this.pointerData.get(e.pointerId) ?? { startX: e.x, startY: e.y, currentX: e.x, currentY: e.y };
        existingPointerData.currentX = e.x;
        existingPointerData.currentY = e.y;
        this.pointerData.set(e.pointerId, existingPointerData);
        if (this.pointerAction == 'zoom') {
            this.pointerLastX = this.pinchZoomStuff.centerX;
            this.pointerLastY = this.pinchZoomStuff.centerY;
            let currentDistance = 0;
            for (const [pointerId, { currentX: x, currentY: y }] of this.pointerData) {
                const x2 = (x - this.pinchZoomStuff.centerX) * (x - this.pinchZoomStuff.centerX);
                const y2 = (y - this.pinchZoomStuff.centerY) * (y - this.pinchZoomStuff.centerY);
                currentDistance += Math.sqrt(x2 + y2);
            }
            this.pinchZoomStuff.currentDistance = (currentDistance / this.pointerData.size);
        }
        else {
            this.pointerLastX = e.x;
            this.pointerLastY = e.y;
        }
        const prevFocus = [this.focusXP, this.focusYP];
        this.focusXP = (this.pointerLastX - this.lastCommittedState.transformX) / this.lastCommittedState.scaleUsed / this.elementBaseWidth;
        this.focusYP = (this.pointerLastY - this.lastCommittedState.transformY) / this.lastCommittedState.scaleUsed / this.elementBaseHeight;
        this.onFocusChange?.(e, this.focusXPixel, this.focusYPixel);
        if (this.ignoreMouseFocus) {
            [this.focusXP, this.focusYP] = [...prevFocus];
        }
        if (this.pointerAction == 'pan') {
            if (!this._firstMoveAfterPointerLockThatShouldBeIgnored) {
                for (const [pointerId, data] of this.pointerData) {
                    // Note: Sometimes (as in, when clicking near the edges of the screen???????)
                    // e.movementX is set to absurdly high values.
                    // Conveniently, these values are around 50% of the screen size, which is much faster
                    // than the mouse will typically be moved for most screens. And on mobile,
                    // we don't capture the pointer in the first place.
                    //
                    // Anyway, find and discard those weird "movementX is too high" values.
                    //
                    // And we can't use, e.g., screenX, because that stays locked during pointer lock.
                    let movementX = (this.pointerIsLocked ? -e.movementX : (data.startX - e.x));
                    let movementY = (this.pointerIsLocked ? -e.movementY : (data.startY - e.y));
                    this._debug();
                    let tooFast = (Math.abs(movementX) > window.innerWidth / 3 || Math.abs(movementY) > window.innerHeight / 3);
                    if (!tooFast) {
                        this.panDeltaX = (movementX) / this.lastCommittedState.scaleUsed;
                        this.panDeltaY = (movementY) / this.lastCommittedState.scaleUsed;
                        this.recalculate();
                    }
                    else {
                        console.log(`Discarding mouse movement at speed [${movementX}, ${movementY}]`);
                    }
                    this.pointerData.set(pointerId, { ...data, startX: e.x, startY: e.y });
                    break;
                }
            }
            this._firstMoveAfterPointerLockThatShouldBeIgnored = false;
        }
        else if (this.pointerAction == 'zoom') {
            this.scaleRequested = (this.pinchZoomStuff.initialScaleRequested * (this.pinchZoomStuff.currentDistance / this.pinchZoomStuff.initialDistance));
            this._debug();
            this.recalculate();
        }
    }
    zoomWithWheel(e) {
        e.preventDefault();
        this.pointerLastX = e.x;
        this.pointerLastY = e.y;
        const prevFocus = [this.focusXP, this.focusYP];
        this.focusXP = (this.pointerLastX - this.lastCommittedState.transformX) / this.lastCommittedState.scaleUsed / this.elementBaseWidth;
        this.focusYP = (this.pointerLastY - this.lastCommittedState.transformY) / this.lastCommittedState.scaleUsed / this.elementBaseHeight;
        this.onFocusChange?.(e, this.focusXPixel, this.focusYPixel);
        if (this.ignoreMouseFocus) {
            [this.focusXP, this.focusYP] = [...prevFocus];
        }
        let deltaXDivisor = 1;
        let deltaYDivisor = 1;
        let deltaZDivisor = 1;
        /**
         *
         * Just documenting some problems that need to be solved here.
         *
         * 1. This has to handle both scrolling and zooming, they both come in as wheel events
         * 2. The delta values that make sense for scrolling are different than for zooming
         * 3. Mouse "wheel" events are chunky 100px values. Trackpad "wheel" events are fine 1px values.
         * 4. Safari on Mac seems to have values of e.x that don't depend on devicePixelRatio, I think?
         *
         */
        if (e.deltaMode == e.DOM_DELTA_PIXEL) {
            deltaXDivisor = 20;
            deltaYDivisor = 20;
            deltaZDivisor = 20;
        }
        else if (e.deltaMode == e.DOM_DELTA_LINE) {
            deltaXDivisor = 10;
            deltaYDivisor = 10;
            deltaZDivisor = 10;
        }
        else if (e.deltaMode == e.DOM_DELTA_PAGE) {
            deltaXDivisor = 1;
            deltaYDivisor = 1;
            deltaZDivisor = 1;
        }
        let normalizedDeltaX = e.deltaX / deltaXDivisor;
        let normalizedDeltaY = e.deltaY / deltaYDivisor;
        let normalizedDeltaZ = e.deltaZ / deltaZDivisor;
        if (e.altKey) {
            normalizedDeltaX = normalizedDeltaY;
            normalizedDeltaY = 0;
            if (!e.ctrlKey)
                normalizedDeltaX *= 8;
        }
        //this.onPointerMove(e);
        if (e.ctrlKey && !e.altKey) {
            // This is (probably) a touchpad pinch-to-zoom gesture.
            // Wish we could capture these on touchscreens too.......
            normalizedDeltaY /= 5;
            this.scaleRequested = Math.max(1, this.scaleRequested + -normalizedDeltaY);
        }
        else {
            if (normalizedDeltaX != 0) {
                this.panDeltaX = normalizedDeltaX;
                this.recalculate();
            }
            else if (normalizedDeltaY != 0) {
                this.panDeltaY = normalizedDeltaY;
                this.recalculate();
            }
            //  this.scaleRequested = Math.max(1, this.scaleRequested + -(e.deltaY / 100))
        }
        this.recalculate();
    }
    recalculationScheduled = false;
    recalculate() {
        this._recalculateImpl();
        //if (!this.recalculationScheduled) {
        //    this.recalculationScheduled = true;
        //    requestAnimationFrame(() => this._recalculateImpl())
        //}
    }
    _recalculateImpl() {
        this.recalculationScheduled = false;
        const parentWidth = this.parent.offsetWidth;
        const parentHeight = this.parent.offsetHeight;
        let nextScale = roundByDevicePixels(this.scaleRequested, this.step);
        let prevScale = this.lastCommittedState.scaleUsed;
        /**
         * This is both more and less complicated than it looks.
         * You wanna see the spreadsheet?
         */
        const focusRatioX = this.focusXP;
        const focusRatioY = this.focusYP;
        const targetRatioX = ((this.lastCommittedState.targetXP * this.elementBaseWidth) + this.panDeltaX) / (this.elementBaseWidth);
        const targetRatioY = ((this.lastCommittedState.targetYP * this.elementBaseHeight) + this.panDeltaY) / (this.elementBaseHeight);
        let scaleRatio = (prevScale / nextScale);
        let nextTargetX = ((targetRatioX * scaleRatio) + ((focusRatioX) * (1 - scaleRatio)));
        let nextTargetY = ((targetRatioY * scaleRatio) + ((focusRatioY) * (1 - scaleRatio)));
        nextTargetX *= this.elementBaseWidth;
        nextTargetY *= this.elementBaseHeight;
        const prevScaledWidth = this.elementBaseWidth * this.lastCommittedState.scaleUsed;
        const prevScaledHeight = this.elementBaseHeight * this.lastCommittedState.scaleUsed;
        const newScaledWidth = this.elementBaseWidth * nextScale;
        const newScaledHeight = this.elementBaseHeight * nextScale;
        //let bottomEdgeWithinViewport = (nextTargetY + newScaledHeight / 2 < parentHeight);
        //let leftEdgeWithinViewport = (nextTargetX + newScaledWidth / 2 > 0);
        //let rightEdgeWithinViewport = (nextTargetX + newScaledWidth / 2 < parentWidth);
        const centerYForScreenV = (parentHeight / newScaledHeight / 2);
        const centerYForScreenTop = Math.round(centerYForScreenV * this.elementBaseHeight);
        const centerYForScreenBottom = Math.round((1 - centerYForScreenV) * this.elementBaseHeight);
        const centerXForScreenX = (parentWidth / newScaledWidth / 2);
        const centerXForScreenLeft = Math.round(centerXForScreenX * this.elementBaseWidth);
        const centerXForScreenRight = Math.round((1 - centerXForScreenX) * this.elementBaseWidth);
        const extraSpaceAtBottom = (nextTargetY >= centerYForScreenBottom);
        const extraSpaceAtTop = (nextTargetY <= centerYForScreenTop);
        const extraSpaceForY = (prevScaledHeight <= parentHeight);
        const extraSpaceAtRight = (nextTargetX >= centerXForScreenRight);
        const extraSpaceAtLeft = (nextTargetX <= centerXForScreenLeft);
        const extraSpaceForX = (newScaledWidth <= parentWidth);
        // Don't allow area above/below the child's bounds to be visible.
        // If that's not possible, generally because we're zoomed out 
        // too far, then always align to the bottom.
        if (extraSpaceAtBottom || extraSpaceForY) {
            nextTargetY = centerYForScreenBottom;
        }
        else if (extraSpaceAtTop) {
            nextTargetY = centerYForScreenTop;
        }
        // Same for the X axis; don't allow area to the left/right
        // of the child's bounds to be visible. If that's not possible,
        // generally because we're zoomed out too far, then always center
        // the child (centering is, like, the one operation that's
        // super easy).
        if (extraSpaceForX || (extraSpaceAtLeft && extraSpaceAtRight)) {
            nextTargetX = Math.round(this.elementBaseWidth / 2);
        }
        else if (extraSpaceAtLeft) {
            if (nextScale == 1)
                debugger;
            nextTargetX = centerXForScreenLeft;
        }
        else if (extraSpaceAtRight) {
            if (nextScale == 1)
                debugger;
            nextTargetX = centerXForScreenRight;
        }
        this.element.dataset["targetX"] = nextTargetX.toString();
        this.element.dataset["targetY"] = nextTargetY.toString();
        //this.element.dataset["focusX"] = nextStateToCommit.focusX.toString();
        //this.element.dataset["focusY"] = nextStateToCommit.focusY.toString();
        this.element.dataset["parentWidth"] = parentWidth.toString();
        this.element.dataset["parentHeight"] = parentHeight.toString();
        this.element.dataset["scaleUsed"] = nextScale.toString();
        // The rounding here is to ensure we stay on pixel boundaries.
        const parentCenterX = Math.round(this.parent.offsetWidth / 2 / nextScale) * nextScale;
        const parentCenterY = Math.round(this.parent.offsetHeight / 2 / nextScale) * nextScale;
        let transformXSuperRounded = parentCenterX - nextTargetX * nextScale;
        let transformYSuperRounded = parentCenterY - nextTargetY * nextScale;
        transformXSuperRounded = Math.round(transformXSuperRounded / nextScale) * nextScale;
        transformYSuperRounded = Math.round(transformYSuperRounded / nextScale) * nextScale;
        let nextStateToCommit = {
            scaleUsed: nextScale,
            targetXP: nextTargetX / this.elementBaseWidth,
            targetYP: nextTargetY / this.elementBaseHeight,
            transformX: transformXSuperRounded,
            transformY: transformYSuperRounded
        };
        if (nextStateToCommit.scaleUsed != this.lastCommittedState.scaleUsed ||
            nextStateToCommit.transformX != this.lastCommittedState.transformX ||
            nextStateToCommit.transformY != this.lastCommittedState.transformY) {
            this.pannedOrZoomedDuringPointerDown = true;
        }
        const t = nextScale.toString();
        this.element.style.setProperty("transform-origin", `${0}px ${0}px`);
        this.element.style.setProperty("transform", `translate(${transformXSuperRounded}px, ${transformYSuperRounded}px) scale(${t})`);
        this.onScaleChange?.(nextScale);
        // document.getElementById("cursor")?.style.removeProperty("weird-scale-thing");
        // Needed to reset the focus position properly on zoom
        this.focusXP = (this.pointerLastX - this.lastCommittedState.transformX) / this.lastCommittedState.scaleUsed / this.elementBaseWidth;
        this.focusYP = (this.pointerLastY - this.lastCommittedState.transformY) / this.lastCommittedState.scaleUsed / this.elementBaseHeight;
        this._debug();
        this.lastCommittedState = { ...nextStateToCommit };
    }
}
//# sourceMappingURL=index.js.map