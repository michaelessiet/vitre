import { describe, expect, it, vi } from "vite-plus/test";
import { createChatScroll } from "./chatScroll";

function position(content: number, viewport: number, offset: number) {
  return {
    contentSize: { height: content },
    layoutMeasurement: { height: viewport },
    contentOffset: { y: offset },
  };
}

function scrolling() {
  let nextFrame = 0;
  const pending = new Map<number, () => void>();
  const scrollToOffset = vi.fn();
  const cancel = vi.fn((frame: number) => pending.delete(frame));
  const controller = createChatScroll({
    scrollToOffset,
    schedule: (callback) => {
      const frame = nextFrame++;
      pending.set(frame, callback);
      return frame;
    },
    cancel,
  });
  return {
    controller,
    scrollToOffset,
    cancel,
    pending,
    flush() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("chat scrolling", () => {
  it("keeps following when passive growth scroll events arrive before content measurements", () => {
    const chat = scrolling();
    chat.controller.viewportChanged(600);
    chat.controller.contentChanged(1200);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(600);

    // Native can report a larger content size before onContentSizeChange.
    chat.controller.scroll(position(1800, 600, 600));
    chat.controller.contentChanged(1800);
    chat.controller.contentChanged(2000);
    expect(chat.pending.size).toBe(1);
    chat.flush();

    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1400);
    expect(chat.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it("follows every measurement batch until variable-height initial history reaches its end", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1200);
    expect(chat.pending.size).toBe(0);
    chat.controller.viewportChanged(600);
    chat.flush();

    for (const height of [2500, 6200, 5900, 10480]) {
      chat.controller.scroll(position(height, 600, 600));
      chat.controller.contentChanged(height);
      chat.flush();
      expect(chat.scrollToOffset).toHaveBeenLastCalledWith(height - 600);
    }
    expect(chat.scrollToOffset).toHaveBeenCalledTimes(5);
  });

  it("keeps the latest content visible through keyboard and composer viewport resizing", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.flush();

    chat.controller.scroll(position(1800, 300, 1200));
    chat.controller.viewportChanged(300);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1500);

    chat.controller.viewportChanged(240);
    chat.controller.contentChanged(2100);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1860);

    chat.controller.viewportChanged(600);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1500);
  });

  it("cancels queued following when the reader drags up and preserves that position", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.controller.beginInteraction();
    expect(chat.cancel).toHaveBeenCalledOnce();
    expect(chat.pending.size).toBe(0);
    chat.controller.scroll(position(1800, 600, 600));
    chat.controller.contentChanged(2100);
    chat.controller.endInteraction(position(2100, 600, 600));

    chat.controller.contentChanged(2400);
    chat.controller.viewportChanged(300);
    // A passive event cannot override the reader's decision to read history.
    chat.controller.scroll(position(2400, 300, 2100));
    chat.flush();
    expect(chat.scrollToOffset).not.toHaveBeenCalled();
  });

  it("cancels an end-of-drag correction when momentum continues away from the bottom", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.flush();
    chat.scrollToOffset.mockClear();

    chat.controller.beginInteraction();
    chat.controller.endInteraction(position(1800, 600, 1150));
    expect(chat.pending.size).toBe(1);
    chat.controller.beginInteraction();
    expect(chat.pending.size).toBe(0);
    chat.controller.scroll(position(1800, 600, 400));
    chat.controller.contentChanged(2200);
    chat.controller.endInteraction(position(2200, 600, 400));
    chat.flush();

    expect(chat.scrollToOffset).not.toHaveBeenCalled();
  });

  it("resumes following after the reader scrolls back near the bottom", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.controller.beginInteraction();
    chat.controller.endInteraction(position(1800, 600, 300));
    chat.controller.contentChanged(2200);

    chat.controller.beginInteraction();
    chat.controller.scroll(position(2200, 600, 1500));
    chat.controller.endInteraction(position(2200, 600, 1500));
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1600);

    chat.controller.contentChanged(2500);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenLastCalledWith(1900);
  });

  it("repins after an explicit send and uses the newest size in the queued frame", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.controller.beginInteraction();
    chat.controller.endInteraction(position(1800, 600, 300));
    chat.controller.followLatest();
    chat.controller.contentChanged(2100);
    chat.flush();

    expect(chat.scrollToOffset).toHaveBeenCalledExactlyOnceWith(1500);
  });

  it("does not scroll before layout or beyond the start of short content", () => {
    const chat = scrolling();
    chat.controller.contentChanged(100);
    chat.controller.viewportChanged(0);
    chat.controller.followLatest();
    chat.flush();
    expect(chat.scrollToOffset).not.toHaveBeenCalled();

    chat.controller.viewportChanged(600);
    chat.flush();
    expect(chat.scrollToOffset).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("cancels a pending frame on disposal", () => {
    const chat = scrolling();
    chat.controller.contentChanged(1800);
    chat.controller.viewportChanged(600);
    chat.controller.dispose();
    chat.controller.dispose();
    chat.flush();

    expect(chat.cancel).toHaveBeenCalledOnce();
    expect(chat.pending.size).toBe(0);
    expect(chat.scrollToOffset).not.toHaveBeenCalled();
  });
});
