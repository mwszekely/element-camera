interface ElementCameraState {
    /**
     * The scale that's actually currently being used
     */
    scaleUsed: number;
    /**
     * This is the position on the target element that we want to be "looking at", or centered on.
     *
     * It can be negative, in which case we're targeting an area outside of the child element's bounds.
     *
     * This happens, for example, when the child is very small and aligned to the bottom of the area;
     * its targetY will be a negative value to push the child itself far downwards.
     *
     * Coordinates are expected to be in the range of [0, 1] (as opposed to a pixel position on the image)
     */
    targetXP: number;
    targetYP: number;
    /**
     * The actual position the child element has been positioned to, after scaling.
     *
     * This is used to map pointer events from the parent's coordinate space to the child's.
     */
    transformX: number;
    transformY: number;
}
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
export declare function roundByDevicePixels(x: number, step: number, op?: (x: number) => number): number;
export declare class ElementCamera {
    element: HTMLElement;
    parent: HTMLElement;
    /**
     * The size of the child element that we're panning and zooming around.
     *
     * It's expected that these don't change throughout the lifetime of the class,
     * which is true in all cases right now. But this should probably be changed
     * in the future...
     */
    elementBaseWidth: number;
    elementBaseHeight: number;
    lastCommittedState: ElementCameraState;
    /**
     * The scale that's currently requested.
     *
     * We use this to handle "fine" scroll wheels,
     * like those on Mac devices, vs "coarse" scroll wheels,
     * like those on a normal mouse wheel.
     *
     */
    scaleRequested: number;
    /**
     * Where is the user currently focused on the child image?
     *
     * This is where zoom events will be relative to.
     */
    focusXP: number;
    focusYP: number;
    /**
     * The next time we update, how far should the image be panned?
     *
     * Should be a number of pixels relative to the unscaled child element.
     */
    panDeltaX: number;
    panDeltaY: number;
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
    pointerLastX: number;
    pointerLastY: number;
    usePointerLock: boolean;
    /**
     * Can be optionally set to round the final scale to the given interval.
     *
     * Used for hi-res mode mostly.
     */
    step: number;
    onFocusChange?: (e: PointerEvent | WheelEvent, x: number, y: number) => void;
    onScaleChange?: (newScale: number) => void;
    onClick?: (e: PointerEvent, x: number, y: number) => void;
    constructor(element: HTMLElement, initialStep?: number);
    ignoreMouseFocus: boolean;
    setPosition(centerX: number, centerY: number): void;
    /** Returns the unscaled pixel coordinate that is currently being focused (e.g. hovered by the mouse) */
    get focusXPixel(): number;
    get focusYPixel(): number;
    private pointerIsLocked;
    private _onPointerLockChange;
    [Symbol.dispose](): void;
    /**
     * Used to determine if click events are allowed to run
     * after pointerup (i.e. if we move or zoom, there's
     * no click event.)
     */
    private pannedOrZoomedDuringPointerDown;
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
    private pointerAction;
    /**
     * Keep track of the pointer data we have.
     *
     * For mouse-like pointers, this will always only have a single entry.
     *
     * For touch-like pointers, it will have multiple during zoom gestures, but one otherwise.
     */
    private pointerData;
    /**
     * We just need some extra state for pinch-zooming to work,
     * so here it is, isolated from the rest of the class state.
     */
    private pinchZoomStuff;
    private _firstMoveAfterPointerLockThatShouldBeIgnored;
    private onPointerDown;
    _debug(): void;
    private onPointerUp;
    private onPointerMove;
    zoomWithWheel(e: WheelEvent): void;
    private recalculationScheduled;
    recalculate(): void;
    private _recalculateImpl;
}
export {};
//# sourceMappingURL=index.d.ts.map