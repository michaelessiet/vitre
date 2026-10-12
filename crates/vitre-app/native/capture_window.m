#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdlib.h>
#include <unistd.h>

// Runs inside Vitre, so TCC checks the same signed app the user authorized.
// The caller uses a worker thread: neither semaphore may block the UI thread.
int vitre_capture_own_window(const char *output_path) {
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            if (!CGPreflightScreenCaptureAccess()) {
                fprintf(stderr, "[vitre-capture] Screen Recording is unavailable for this Vitre build\n");
                return 2;
            }

            dispatch_semaphore_t listed = dispatch_semaphore_create(0);
            __block SCWindow *selected = nil;
            __block NSError *list_error = nil;
            [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
                list_error = error;
                for (SCWindow *window in content.windows) {
                    if (window.owningApplication.processID != getpid()) continue;
                    if (!selected || window.frame.size.width * window.frame.size.height >
                                         selected.frame.size.width * selected.frame.size.height) {
                        selected = window;
                    }
                }
                dispatch_semaphore_signal(listed);
            }];
            if (dispatch_semaphore_wait(listed, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC))) {
                fprintf(stderr, "[vitre-capture] timed out listing windows\n");
                return 3;
            }
            if (!selected) {
                fprintf(stderr, "[vitre-capture] Vitre window unavailable: %s\n",
                        list_error.localizedDescription.UTF8String ?: "no matching window");
                return 4;
            }

            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
            SCStreamConfiguration *configuration = [SCStreamConfiguration new];
            configuration.width = (NSUInteger)(selected.frame.size.width * 2);
            configuration.height = (NSUInteger)(selected.frame.size.height * 2);
            configuration.showsCursor = NO;
            if (getenv("VITRE_MARKETING_CAPTURE")) {
                CGPoint quiet_point = CGPointMake(selected.frame.origin.x + selected.frame.size.width * 0.45,
                                                  selected.frame.origin.y + selected.frame.size.height * 0.2);
                CGWarpMouseCursorPosition(quiet_point);
                usleep(400000);
            }

            dispatch_semaphore_t captured = dispatch_semaphore_create(0);
            __block NSData *png = nil;
            __block NSError *capture_error = nil;
            [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *error) {
                capture_error = error;
                if (image) {
                    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
                    png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                }
                dispatch_semaphore_signal(captured);
            }];
            if (dispatch_semaphore_wait(captured, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC))) {
                fprintf(stderr, "[vitre-capture] timed out capturing window\n");
                return 5;
            }
            if (!png) {
                fprintf(stderr, "[vitre-capture] capture failed: %s\n",
                        capture_error.localizedDescription.UTF8String ?: "no image returned");
                return 6;
            }
            NSError *write_error = nil;
            if (![png writeToFile:[NSString stringWithUTF8String:output_path] options:NSDataWritingAtomic error:&write_error]) {
                fprintf(stderr, "[vitre-capture] could not save PNG: %s\n", write_error.localizedDescription.UTF8String);
                return 7;
            }
            return 0;
        }
        fprintf(stderr, "[vitre-capture] fixture capture requires macOS 14 or later\n");
        return 8;
    }
}
