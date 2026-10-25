interface ScrollPosition {
  contentSize: { height: number };
  layoutMeasurement: { height: number };
  contentOffset: { y: number };
}

/** Follow layout changes until the reader deliberately scrolls away. */
export function createChatScroll(options: {
  scrollToOffset: (offset: number) => void;
  schedule: (callback: () => void) => number;
  cancel: (frame: number) => void;
}) {
  let following = true;
  let interacting = false;
  let contentHeight = 0;
  let viewportHeight = 0;
  let frame: number | null = null;

  const cancel = () => {
    if (frame !== null) options.cancel(frame);
    frame = null;
  };
  const schedule = () => {
    if (!following || interacting || viewportHeight <= 0 || frame !== null) return;
    frame = options.schedule(() => {
      frame = null;
      if (following && !interacting)
        options.scrollToOffset(Math.max(0, contentHeight - viewportHeight));
    });
  };
  const scroll = (position: ScrollPosition) => {
    // Native scroll events also fire while rows mount, text streams, and the
    // keyboard resizes the list. Those must not turn off following.
    if (interacting)
      following =
        position.contentSize.height -
          position.layoutMeasurement.height -
          position.contentOffset.y <=
        100;
  };
  return {
    contentChanged(height: number) {
      contentHeight = height;
      schedule();
    },
    viewportChanged(height: number) {
      viewportHeight = height;
      schedule();
    },
    beginInteraction() {
      interacting = true;
      cancel();
    },
    scroll,
    endInteraction(position: ScrollPosition) {
      scroll(position);
      interacting = false;
      schedule();
    },
    followLatest() {
      following = true;
      interacting = false;
      schedule();
    },
    dispose: cancel,
  };
}
