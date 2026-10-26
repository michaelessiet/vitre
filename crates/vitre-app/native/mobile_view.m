// Direct simulator display and HID bridge. Private CoreSimulator selectors and
// Indigo wire layout are documented by Meta's MIT-licensed facebook/idb
// project. No Simulator.app window capture, browser, image encoding, or Java
// helper.
// Portions adapted from https://github.com/facebook/idb
/*
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
#import <Accelerate/Accelerate.h>
#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <xpc/xpc.h>

@interface NSObject (VitreSimulator)
+ (id)sharedServiceContextForDeveloperDir:(id)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (id)io;
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid
                          callbackQueue:(dispatch_queue_t)queue
                          frameCallback:(void (^)(void))frame
                surfacesChangedCallback:(void (^)(id, id))surfaces
              propertiesChangedCallback:(void (^)(id))properties;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)uuid;
- (NSArray *)ioPorts;
- (id)descriptor;
- (id)framebufferSurface;
- (id)ioSurface;
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)registerCallbackWithUUID:(NSUUID *)uuid
        ioSurfacesChangeCallback:(void (^)(id))callback;
- (void)registerCallbackWithUUID:(NSUUID *)uuid
        damageRectanglesCallback:(void (^)(id))callback;
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid;
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid;
- (void)sendWithMessage:(void *)message
           freeWhenDone:(BOOL)free
        completionQueue:(dispatch_queue_t)queue
             completion:(void (^)(NSError *))completion;
@end

typedef void (*InputCallback)(void *, const char *);
typedef void (*DestroyCallback)(void *);
typedef void *(*TouchBuilder)(CGPoint *, CGPoint *, uint32_t, NSUInteger,
                              CGSize, uint32_t);
typedef void *(*ButtonBuilder)(int, int, int);

static const char *HIDService =
    "com.apple.coredevice.feature.remote.hid.digitizer";
static xpc_object_t hidMessage(const char *type, xpc_object_t payload,
                               bool barrier) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", type);
  xpc_dictionary_set_string(message, "featureIdentifier", HIDService);
  xpc_dictionary_set_bool(message, "isBarrier", barrier);
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}
static xpc_object_t keyboardMessage(uint64_t usage, uint64_t state,
                                    bool barrier) {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", state);
  return hidMessage("IndigoKeyboardButtonEvent", payload, barrier);
}
// Resolve the guest's Mach service. The simulator-specific endpoint bridge is
// essential: a normal host XPC connection never delivers its messages to
// dtuhidd.
static xpc_connection_t connectHID(id device, dispatch_queue_t queue,
                                   NSError **error) {
  typedef void *(*EndpointBuilder)(mach_port_t, uint64_t, uint64_t);
  typedef void (*EnableSimulator)(xpc_connection_t);
  EndpointBuilder endpoint = (EndpointBuilder)dlsym(
      RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  EnableSimulator enable = (EnableSimulator)dlsym(
      RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpoint || !enable)
    return nil;
  mach_port_t port = [device lookup:[NSString stringWithUTF8String:HIDService]
                              error:error];
  if (!port)
    return nil;
  xpc_object_t remote = (__bridge_transfer xpc_object_t)endpoint(port, 0, 0);
  if (!remote)
    return nil;
  xpc_connection_t connection = xpc_connection_create_from_endpoint(remote);
  if (!connection)
    return nil;
  enable(connection);
  xpc_connection_set_target_queue(connection, queue);
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_ERROR)
      NSLog(@"[mobile] Simulator HID: %s",
            xpc_dictionary_get_string(event, XPC_ERROR_KEY_DESCRIPTION));
  });
  xpc_connection_resume(connection);
  dispatch_semaphore_t ready = dispatch_semaphore_create(0);
  __block bool alive = false;
  xpc_connection_send_message_with_reply(
      connection, keyboardMessage(0, 2, true), queue, ^(xpc_object_t reply) {
        alive = xpc_get_type(reply) != XPC_TYPE_ERROR;
        dispatch_semaphore_signal(ready);
      });
  if (dispatch_semaphore_wait(
          ready, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) ||
      !alive) {
    xpc_connection_cancel(connection);
    if (error)
      *error =
          [NSError errorWithDomain:@"dev.vitre.mobile"
                              code:1
                          userInfo:@{
                            NSLocalizedDescriptionKey :
                                @"The simulator HID service did not respond. "
                                @"Wait for boot to finish and reconnect."
                          }];
    return nil;
  }
  // The daemon replies before it finishes opening its virtual HID devices.
  [NSThread sleepForTimeInterval:0.2];
  return connection;
}

@interface VitreMobileFrame : NSObject
@property(nonatomic) IOSurfaceRef surface;
@property(nonatomic) CVPixelBufferRef buffer;
@end
@implementation VitreMobileFrame
- (void)dealloc {
  if (_surface)
    CFRelease(_surface);
  if (_buffer)
    CFRelease(_buffer);
}
@end

@interface VitreMobileView : NSView {
@public
  InputCallback input;
  DestroyCallback destroy;
  void *inputContext;
  NSLock *lock;
  VitreMobileFrame *latest;
  BOOL scheduled;
  BOOL stopped;
  uint64_t received;
  uint64_t presented;
  uint32_t width, height;
  CVPixelBufferPoolRef pool;
  id descriptor;
  id simulatorContext;
  id simulatorDevice;
  id simulatorIO;
  id simulatorSet;
  NSArray *simulatorPorts;
  id hid;
  xpc_connection_t modernHID;
  BOOL screenCallbacks;
  BOOL touching;
  BOOL scrolling;
  BOOL scrollPending;
  uint64_t scrollGeneration;
  CGPoint scrollTarget;
  CGPoint contact;
  NSUUID *callbackID;
  dispatch_queue_t inputQueue;
  dispatch_queue_t frameQueue;
  id mouseFocusMonitor;
  TouchBuilder touchBuilder;
  ButtonBuilder buttonBuilder;
  uint32_t edge;
}
@property(nonatomic) id<MTLDevice> gpu;
@property(nonatomic) id<MTLCommandQueue> commands;
@property(nonatomic) id<MTLRenderPipelineState> pipeline;
@end

@implementation VitreMobileView
- (BOOL)isFlipped {
  return YES;
}
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  return YES;
}
- (BOOL)acceptsFirstResponder {
  return YES;
}
- (instancetype)initWithFrame:(NSRect)frame {
  if (!(self = [super initWithFrame:frame]))
    return nil;
  lock = [NSLock new];
  inputQueue =
      dispatch_queue_create("dev.vitre.mobile.input", DISPATCH_QUEUE_SERIAL);
  _gpu = MTLCreateSystemDefaultDevice();
  _commands = [_gpu newCommandQueue];
  CAMetalLayer *layer = [CAMetalLayer layer];
  layer.device = _gpu;
  layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  layer.framebufferOnly = YES;
  layer.opaque = YES;
  self.wantsLayer = YES;
  self.layer = layer;
  NSString *source =
      @"#include <metal_stdlib>\nusing namespace metal; struct V { float4 p "
      @"[[position]]; float2 uv; }; vertex V mobile_v(uint i [[vertex_id]], "
      @"constant float2 &scale [[buffer(0)]]) { float2 "
      @"p[4]={float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)}; float2 "
      @"uv[4]={float2(0,0),float2(0,1),float2(1,0),float2(1,1)}; return "
      @"{float4(p[i]*scale,0,1),uv[i]}; } fragment float4 mobile_f(V v "
      @"[[stage_in]], texture2d<float> t [[texture(0)]]) { constexpr sampler "
      @"s(filter::linear); return float4(t.sample(s,v.uv).rgb,1); }";
  NSError *error = nil;
  id<MTLLibrary> library = [_gpu newLibraryWithSource:source
                                              options:nil
                                                error:&error];
  MTLRenderPipelineDescriptor *pipeline = [MTLRenderPipelineDescriptor new];
  pipeline.vertexFunction = [library newFunctionWithName:@"mobile_v"];
  pipeline.fragmentFunction = [library newFunctionWithName:@"mobile_f"];
  pipeline.colorAttachments[0].pixelFormat = layer.pixelFormat;
  _pipeline = [_gpu newRenderPipelineStateWithDescriptor:pipeline error:&error];
  if (!_pipeline) {
    NSLog(@"[mobile] Metal setup failed: %@", error);
    return nil;
  }
  return self;
}
- (NSRect)displayRect {
  [lock lock];
  uint32_t w = width, h = height;
  [lock unlock];
  if (!w || !h)
    return NSZeroRect;
  CGFloat scale = MIN(self.bounds.size.width / w, self.bounds.size.height / h);
  NSSize size = NSMakeSize(w * scale, h * scale);
  return NSMakeRect((self.bounds.size.width - size.width) / 2,
                    (self.bounds.size.height - size.height) / 2, size.width,
                    size.height);
}
- (void)acceptFrame:(VitreMobileFrame *)frame {
  [lock lock];
  if (stopped) {
    [lock unlock];
    return;
  }
  latest = frame;
  received++;
  width = (uint32_t)IOSurfaceGetWidth(frame.surface);
  height = (uint32_t)IOSurfaceGetHeight(frame.surface);
  BOOL enqueue = !scheduled;
  scheduled = YES;
  [lock unlock];
  // One pending main-thread draw: replace stale frames instead of queueing
  // latency.
  if (enqueue)
    dispatch_async(dispatch_get_main_queue(), ^{
      [self drawLatest];
    });
}
- (void)drawLatest {
  [lock lock];
  VitreMobileFrame *frame = latest;
  scheduled = NO;
  BOOL closed = stopped;
  [lock unlock];
  if (closed || !frame || self.hidden || !self.window)
    return;
  CAMetalLayer *layer = (CAMetalLayer *)self.layer;
  CGFloat scale = self.window.backingScaleFactor;
  layer.contentsScale = scale;
  layer.drawableSize = CGSizeMake(self.bounds.size.width * scale,
                                  self.bounds.size.height * scale);
  id<CAMetalDrawable> drawable = [layer nextDrawable];
  if (!drawable)
    return;
  OSType format = IOSurfaceGetPixelFormat(frame.surface);
  MTLPixelFormat pixelFormat = format == kCVPixelFormatType_32RGBA
                                   ? MTLPixelFormatRGBA8Unorm
                                   : MTLPixelFormatBGRA8Unorm;
  MTLTextureDescriptor *td = [MTLTextureDescriptor
      texture2DDescriptorWithPixelFormat:pixelFormat
                                   width:IOSurfaceGetWidth(frame.surface)
                                  height:IOSurfaceGetHeight(frame.surface)
                               mipmapped:NO];
  td.usage = MTLTextureUsageShaderRead;
  td.storageMode = MTLStorageModeShared;
  id<MTLTexture> texture = [_gpu newTextureWithDescriptor:td
                                                iosurface:frame.surface
                                                    plane:0];
  if (!texture)
    return;
  MTLRenderPassDescriptor *pass =
      [MTLRenderPassDescriptor renderPassDescriptor];
  pass.colorAttachments[0].texture = drawable.texture;
  pass.colorAttachments[0].loadAction = MTLLoadActionClear;
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  pass.colorAttachments[0].clearColor =
      MTLClearColorMake(0.025, 0.025, 0.03, 1);
  id<MTLCommandBuffer> command = [_commands commandBuffer];
  id<MTLRenderCommandEncoder> encoder =
      [command renderCommandEncoderWithDescriptor:pass];
  [encoder setRenderPipelineState:_pipeline];
  NSRect fit = [self displayRect];
  float fitScale[2] = {(float)(fit.size.width / self.bounds.size.width),
                       (float)(fit.size.height / self.bounds.size.height)};
  [encoder setVertexBytes:fitScale length:sizeof(fitScale) atIndex:0];
  [encoder setFragmentTexture:texture atIndex:0];
  [encoder drawPrimitives:MTLPrimitiveTypeTriangleStrip
              vertexStart:0
              vertexCount:4];
  [encoder endEncoding];
  // Keep pooled Android buffers alive until the GPU has finished reading them.
  [command addCompletedHandler:^(id<MTLCommandBuffer> c) {
    (void)frame.surface;
  }];
  [command presentDrawable:drawable];
  [command commit];
  [lock lock];
  presented++;
  [lock unlock];
}
- (void)emit:(NSDictionary *)value {
  if (input) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                   options:0
                                                     error:nil];
    NSString *json = [[NSString alloc] initWithData:data
                                           encoding:NSUTF8StringEncoding];
    input(inputContext, json.UTF8String);
  }
}
- (void)touch:(double)x y:(double)y phase:(int)phase {
  if (modernHID) {
    dispatch_async(inputQueue, ^{
      if (phase == 0)
        self->edge = y > .97 ? 3 : y < .03 ? 1 : x < .02 ? 2 : x > .98 ? 4 : 0;
      xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
      xpc_dictionary_set_double(point, "x", x);
      xpc_dictionary_set_double(point, "y", y);
      xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
      xpc_dictionary_set_value(payload, "pointOne", point);
      xpc_dictionary_set_uint64(payload, "eventType", phase);
      xpc_dictionary_set_uint64(payload, "edge", self->edge);
      xpc_dictionary_set_uint64(payload, "target", 0);
      if (self->modernHID)
        xpc_connection_send_message(
            self->modernHID,
            hidMessage("IndigoDigitizerEvent", payload, false));
    });
  } else if (hid && touchBuilder) {
    dispatch_async(inputQueue, ^{
      if (phase == 0)
        self->edge = y > .97 ? 3 : y < .03 ? 1 : x < .02 ? 2 : x > .98 ? 4 : 0;
      CGPoint point = CGPointMake(x, y);
      // Indigo's single-contact envelope (0x20 header + two 0x90 payloads).
      void *source = self->touchBuilder(&point, NULL, 0x32, phase == 2 ? 2 : 1,
                                        CGSizeMake(1, 1), self->edge);
      if (!source)
        return;
      uint8_t *message = calloc(1, 0x140);
      uint32_t size = 0x90, kind = 11;
      uint64_t timestamp = mach_absolute_time();
      memcpy(message + 0x18, &size, 4);
      message[0x1c] = 2;
      memcpy(message + 0x20, &kind, 4);
      memcpy(message + 0x24, &timestamp, 8);
      memcpy(message + 0x30, (uint8_t *)source + 0x30, 0x70);
      free(source);
      memcpy(message + 0x3c, &x, 8);
      memcpy(message + 0x44, &y, 8);
      memcpy(message + 0xb0, message + 0x20, 0x90);
      uint32_t one = 1, two = 2;
      memcpy(message + 0xc0, &one, 4);
      memcpy(message + 0xc4, &two, 4);
      @try {
        [self->hid sendWithMessage:message
                      freeWhenDone:YES
                   completionQueue:self->inputQueue
                        completion:^(NSError *error) {
                          if (error)
                            NSLog(@"[mobile] iOS input: %@", error);
                        }];
      } @catch (NSException *e) {
        NSLog(@"[mobile] iOS input: %@", e.reason);
      }
    });
  } else
    [self emit:@{
      @"kind" : @"touch",
      @"x" : @(x),
      @"y" : @(y),
      @"phase" : @(phase)
    }];
}
- (void)mouse:(NSEvent *)event phase:(int)phase {
  NSRect fit = [self displayRect];
  if (fit.size.width <= 0 || fit.size.height <= 0)
    return;
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  if (phase == 0 && !NSPointInRect(p, fit))
    return;
  if (phase == 0) {
    if (scrolling) {
      [self touch:contact.x y:contact.y phase:2];
      scrolling = NO;
      scrollGeneration++;
    }
    touching = YES;
  }
  if (!touching)
    return;
  if (phase == 2)
    touching = NO;
  [self.window makeFirstResponder:self];
  contact =
      CGPointMake(fmax(0, fmin(1, (p.x - fit.origin.x) / fit.size.width)),
                  fmax(0, fmin(1, (p.y - fit.origin.y) / fit.size.height)));
  [self touch:contact.x y:contact.y phase:phase];
}
- (void)mouseDown:(NSEvent *)e {
  [self mouse:e phase:0];
}
- (void)mouseDragged:(NSEvent *)e {
  [self mouse:e phase:1];
}
- (void)mouseUp:(NSEvent *)e {
  [self mouse:e phase:2];
}
// Scroll wheels and trackpads drive a short touch gesture. Coalesce bursts at
// display cadence; otherwise a wheel's instantaneous start/end is seen as a
// tap.
- (void)scrollWheel:(NSEvent *)event {
  if (touching || event.momentumPhase != NSEventPhaseNone)
    return;
  NSRect fit = [self displayRect];
  if (fit.size.width <= 0 || fit.size.height <= 0)
    return;
  double multiplier = event.hasPreciseScrollingDeltas ? 1 : 20;
  double dx = event.scrollingDeltaX * multiplier / fit.size.width;
  double dy = event.scrollingDeltaY * multiplier / fit.size.height;
  if (dx == 0 && dy == 0)
    return;
  if (!scrolling) {
    scrolling = YES;
    contact = scrollTarget = CGPointMake(.5, .5);
    [self touch:contact.x y:contact.y phase:0];
  }
  scrollTarget.x = fmax(.1, fmin(.9, scrollTarget.x + dx));
  scrollTarget.y = fmax(.1, fmin(.9, scrollTarget.y + dy));
  uint64_t generation = ++scrollGeneration;
  if (!scrollPending) {
    scrollPending = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 16 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
                     self->scrollPending = NO;
                     if (!self->scrolling || self.hidden || self->stopped)
                       return;
                     self->contact = self->scrollTarget;
                     [self touch:self->contact.x y:self->contact.y phase:1];
                   });
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
                   if (self->scrolling &&
                       self->scrollGeneration == generation) {
                     [self touch:self->contact.x y:self->contact.y phase:2];
                     self->scrolling = NO;
                   }
                 });
}
- (void)keyDown:(NSEvent *)event {
  if (event.modifierFlags & NSEventModifierFlagCommand) {
    // Commands go to GPUI. Hand AppKit focus back as well, so a shortcut
    // that opens an input can receive the following unmodified keystrokes.
    [self.window makeFirstResponder:self.superview];
    [self.superview keyDown:event];
    return;
  }
  [self emit:@{@"kind" : @"text", @"text" : event.characters ?: @""}];
}
- (void)setHidden:(BOOL)hidden {
  if (hidden && (touching || scrolling)) {
    [self touch:contact.x y:contact.y phase:2];
    touching = NO;
    scrolling = NO;
    scrollGeneration++;
  }
  if (hidden && self.window.firstResponder == self)
    [self.window makeFirstResponder:self.superview];
  [super setHidden:hidden];
}
- (void)disconnect {
  self.hidden = YES;
  if (mouseFocusMonitor) {
    [NSEvent removeMonitor:mouseFocusMonitor];
    mouseFocusMonitor = nil;
  }
  [lock lock];
  stopped = YES;
  [lock unlock];
  @try {
    if (descriptor && callbackID)
      [descriptor unregisterIOSurfacesChangeCallbackWithUUID:callbackID];
  } @catch (NSException *e) {
  } @
  try {
    if (descriptor && callbackID)
      [descriptor unregisterDamageRectanglesCallbackWithUUID:callbackID];
  } @catch (NSException *e) {
  } @
  try {
    if (screenCallbacks && descriptor && callbackID)
      [descriptor unregisterScreenCallbacksWithUUID:callbackID];
  } @catch (NSException *e) {
  }
  descriptor = nil;
  simulatorPorts = nil;
  simulatorSet = nil;
  simulatorIO = nil;
  simulatorDevice = nil;
  simulatorContext = nil;
  dispatch_async(inputQueue, ^{
    self->hid = nil;
    if (self->modernHID)
      xpc_connection_cancel(self->modernHID);
    self->modernHID = nil;
  });
  [self removeFromSuperview];
}
- (void)dealloc {
  if (pool)
    CFRelease(pool);
  if (destroy)
    destroy(inputContext);
}
@end

void *vitre_mobile_create(void *parent, InputCallback input,
                          DestroyCallback destroy, void *context) {
  VitreMobileView *view = [[VitreMobileView alloc] initWithFrame:NSZeroRect];
  if (!view)
    return NULL;
  view->input = input;
  view->destroy = destroy;
  view->inputContext = context;
  [(__bridge NSView *)parent addSubview:view];
  // The device becomes AppKit's first responder for direct typing. GPUI's
  // logical focus changes on a click elsewhere, but AppKit otherwise keeps
  // sending keyDown: to this sibling view until the device is hidden.
  __weak VitreMobileView *weakView = view;
  view->mouseFocusMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown |
                                            NSEventMaskRightMouseDown)
                               handler:^NSEvent *(NSEvent *event) {
                                 VitreMobileView *strong = weakView;
                                 if (strong && event.window == strong.window &&
                                     event.window.firstResponder == strong &&
                                     strong.superview) {
                                   NSPoint point =
                                       [strong.superview convertPoint:event.locationInWindow
                                                            fromView:nil];
                                   if (!NSPointInRect(point, strong.frame))
                                     [event.window makeFirstResponder:strong.superview];
                                 }
                                 return event;
                               }];
  return (__bridge_retained void *)view;
}
void vitre_mobile_destroy(void *handle) {
  dispatch_async(dispatch_get_main_queue(), ^{
    VitreMobileView *view = (__bridge_transfer VitreMobileView *)handle;
    [view disconnect];
  });
}
void vitre_mobile_bounds(void *handle, double x, double y, double w, double h,
                         bool visible) {
  VitreMobileView *v = (__bridge VitreMobileView *)handle;
  NSView *parent = v.superview;
  NSRect rect = NSMakeRect(
      x, parent.isFlipped ? y : parent.bounds.size.height - y - h, w, h);
  BOOL changed = !NSEqualRects(v.frame, rect) || v.hidden == visible;
  v.frame = rect;
  v.hidden = !visible;
  if (changed && visible)
    [v drawLatest];
}
void vitre_mobile_stats(void *handle, uint64_t *frames, uint64_t *draws,
                        uint32_t *w, uint32_t *h) {
  VitreMobileView *v = (__bridge VitreMobileView *)handle;
  [v->lock lock];
  *frames = v->received;
  *draws = v->presented;
  *w = v->width;
  *h = v->height;
  [v->lock unlock];
}
void vitre_mobile_touch(void *handle, double x, double y, int phase) {
  [(__bridge VitreMobileView *)handle touch:x y:y phase:phase];
}
void vitre_mobile_button(void *handle, int button) {
  VitreMobileView *v = (__bridge VitreMobileView *)handle;
  if (v->modernHID)
    dispatch_async(v->inputQueue, ^{
      for (uint64_t state = 1; state <= 2; state++) {
        xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_uint64(payload, "usagePage", 0x0c);
        xpc_dictionary_set_uint64(payload, "usageCode",
                                  button == 1 ? 0x30 : 0x40);
        xpc_dictionary_set_uint64(payload, "state", state);
        if (v->modernHID)
          xpc_connection_send_message(
              v->modernHID, hidMessage("IndigoButtonEvent", payload, false));
      }
    });
  else if (v->hid && v->buttonBuilder)
    dispatch_async(v->inputQueue, ^{
      for (int direction = 1; direction <= 2; direction++) {
        void *m = v->buttonBuilder(button, direction, 0x33);
        @try {
          [v->hid sendWithMessage:m
                     freeWhenDone:YES
                  completionQueue:v->inputQueue
                       completion:^(NSError *e){
                       }];
        } @catch (NSException *e) {
        }
      }
    });
  else
    [v emit:@{@"kind" : @"key", @"key" : button == 0 ? @"GoHome" : @"GoBack"}];
}
// Worker-thread only. CVPixelBufferPool reuses IOSurfaces once GPU reads
// complete.
int vitre_mobile_rgba(void *handle, const uint8_t *bytes, uint32_t w,
                      uint32_t h) {
  if (!w || !h || w > 4096 || h > 4096)
    return 0;
  VitreMobileView *v = (__bridge VitreMobileView *)handle;
  if (v->pool) {
    NSDictionary *attrs =
        (__bridge NSDictionary *)CVPixelBufferPoolGetPixelBufferAttributes(
            v->pool);
    if ([attrs[(__bridge NSString *)kCVPixelBufferWidthKey] unsignedIntValue] !=
            w ||
        [attrs[(__bridge NSString *)kCVPixelBufferHeightKey]
            unsignedIntValue] != h) {
      CFRelease(v->pool);
      v->pool = NULL;
    }
  }
  if (!v->pool) {
    NSDictionary *attrs = @{
      (__bridge NSString *)kCVPixelBufferWidthKey : @(w),
      (__bridge NSString *)kCVPixelBufferHeightKey : @(h),
      (__bridge NSString *)
      kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey : @{},
      (__bridge NSString *)kCVPixelBufferMetalCompatibilityKey : @YES
    };
    CVReturn error = CVPixelBufferPoolCreate(
        NULL, NULL, (__bridge CFDictionaryRef)attrs, &v->pool);
    if (error) {
      NSLog(@"[mobile] pixel pool: %d", error);
      return 0;
    }
  }
  CVPixelBufferRef buffer = NULL;
  NSDictionary *limits =
      @{(__bridge NSString *)kCVPixelBufferPoolAllocationThresholdKey : @4};
  CVReturn error = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
      NULL, v->pool, (__bridge CFDictionaryRef)limits, &buffer);
  if (error) {
    if (error != kCVReturnWouldExceedAllocationThreshold)
      NSLog(@"[mobile] pixel buffer: %d", error);
    return 0;
  }
  CVPixelBufferLockBaseAddress(buffer, 0);
  uint8_t *target = CVPixelBufferGetBaseAddress(buffer);
  size_t stride = CVPixelBufferGetBytesPerRow(buffer);
  // IOSurface-backed CoreVideo buffers support BGRA on macOS, not RGBA.
  // Accelerate performs the channel swap with vector instructions.
  vImage_Buffer source = {(void *)bytes, h, w, (size_t)w * 4};
  vImage_Buffer destination = {target, h, w, stride};
  const uint8_t channels[4] = {2, 1, 0, 3};
  vImagePermuteChannels_ARGB8888(&source, &destination, channels,
                                 kvImageNoFlags);
  CVPixelBufferUnlockBaseAddress(buffer, 0);
  VitreMobileFrame *frame = [VitreMobileFrame new];
  frame.buffer = buffer;
  frame.surface = (IOSurfaceRef)CFRetain(CVPixelBufferGetIOSurface(buffer));
  [v acceptFrame:frame];
  return 1;
}
char *vitre_mobile_ios(void *handle, const char *udid, const char *developer) {
  @autoreleasepool {
    @try {
      dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/"
             "CoreSimulator",
             RTLD_NOW | RTLD_GLOBAL);
      NSString *dir = [NSString stringWithUTF8String:developer];
      NSString *contents = [dir stringByDeletingLastPathComponent];
      NSArray *paths = @[
        [contents stringByAppendingPathComponent:
                      @"SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
        [dir stringByAppendingPathComponent:
                 @"Library/PrivateFrameworks/SimulatorKit.framework/"
                 @"SimulatorKit"]
      ];
      void *kit = NULL;
      for (NSString *path in paths) {
        kit = dlopen(path.UTF8String, RTLD_NOW | RTLD_GLOBAL);
        if (kit)
          break;
      }
      if (!kit)
        return strdup("This Xcode installation has no loadable SimulatorKit.");
      NSError *error = nil;
      id context = [NSClassFromString(@"SimServiceContext")
          sharedServiceContextForDeveloperDir:dir
                                        error:&error];
      id set = [context defaultDeviceSetWithError:&error];
      id device = nil;
      for (id candidate in [set availableDevices])
        if ([[[candidate valueForKey:@"UDID"] UUIDString]
                isEqualToString:[NSString stringWithUTF8String:udid]])
          device = candidate;
      if (!device)
        return strdup("Simulator is no longer available. Refresh Devices.");
      id renderable = nil;
      id deviceIO = [device io];
      NSArray *ports = [deviceIO ioPorts];
      for (id port in ports) {
        id candidate = [port descriptor];
        id surface = nil;
        @try {
          surface = [candidate framebufferSurface];
        } @catch (NSException *e) {
        }
        if (!surface)
          @try {
            surface = [candidate ioSurface];
          } @catch (NSException *e) {
          }
        if (surface &&
            CFGetTypeID((__bridge CFTypeRef)surface) == IOSurfaceGetTypeID()) {
          renderable = candidate;
          break;
        }
      }
      if (!renderable)
        return strdup("The simulator has no active display surface. Boot it in "
                      "Xcode first.");
      VitreMobileView *v = (__bridge VitreMobileView *)handle;
      Class hidClass =
          NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
      if (!hidClass)
        hidClass = NSClassFromString(@"SimDeviceLegacyHIDClient");
      v->modernHID = connectHID(device, v->inputQueue, &error);
      if (!v->modernHID && [error.domain isEqualToString:@"dev.vitre.mobile"])
        return strdup(error.localizedDescription.UTF8String);
      if (!v->modernHID)
        v->hid = [[hidClass alloc] initWithDevice:device error:&error];
      v->touchBuilder =
          (TouchBuilder)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
      v->buttonBuilder = (ButtonBuilder)dlsym(kit, "IndigoHIDMessageForButton");
      if (!v->modernHID && (!v->hid || !v->touchBuilder || !v->buttonBuilder))
        return strdup("This Xcode version does not provide the required "
                      "simulator input API.");
      v->simulatorContext = context;
      v->simulatorDevice = device;
      v->simulatorIO = deviceIO;
      v->simulatorSet = set;
      v->simulatorPorts = ports;
      v->descriptor = renderable;
      v->callbackID = [NSUUID UUID];
      __weak VitreMobileView *weak = v;
      void (^surfaceChanged)(id) = ^(id surface) {
        VitreMobileView *strong = weak;
        if (!strong)
          return;
        if (!surface ||
            CFGetTypeID((__bridge CFTypeRef)surface) != IOSurfaceGetTypeID())
          return;
        if (IOSurfaceGetPixelFormat((__bridge IOSurfaceRef)surface) !=
            kCVPixelFormatType_32BGRA)
          return;
        VitreMobileFrame *frame = [VitreMobileFrame new];
        frame.surface = (IOSurfaceRef)CFRetain((__bridge CFTypeRef)surface);
        [strong acceptFrame:frame];
      };
      void (^frameChanged)(void) = ^{
        VitreMobileView *strong = weak;
        if (!strong)
          return;
        [strong->lock lock];
        VitreMobileFrame *frame = strong->latest;
        [strong->lock unlock];
        if (frame)
          [strong acceptFrame:frame];
      };
      Protocol *screen = NSProtocolFromString(@"SimScreen");
      v->screenCallbacks = screen && [renderable conformsToProtocol:screen];
      NSLog(@"[mobile] iOS display callbacks: %@",
            v->screenCallbacks ? @"SimScreen" : @"legacy");
      if (v->screenCallbacks) {
        v->frameQueue = dispatch_queue_create(
            "dev.vitre.mobile.frames",
            dispatch_queue_attr_make_with_qos_class(
                DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
        [renderable registerScreenCallbacksWithUUID:v->callbackID
                                      callbackQueue:v->frameQueue
                                      frameCallback:frameChanged
                            surfacesChangedCallback:^(id primary, id masked) {
                              surfaceChanged(primary);
                            }
                          propertiesChangedCallback:^(id properties){
                          }];
      } else {
        [renderable registerCallbackWithUUID:v->callbackID
                    ioSurfacesChangeCallback:surfaceChanged];
        [renderable registerCallbackWithUUID:v->callbackID
                    damageRectanglesCallback:^(id rectangles) {
                      frameChanged();
                    }];
      }
      surfaceChanged([renderable framebufferSurface]);
      return NULL;
    } @catch (NSException *e) {
      return strdup(e.reason.UTF8String);
    }
  }
}
int vitre_mobile_snapshot(void *handle, void **bytes, size_t *length) {
  @autoreleasepool {
    VitreMobileView *v = (__bridge VitreMobileView *)handle;
    [v->lock lock];
    VitreMobileFrame *frame = v->latest;
    [v->lock unlock];
    if (!frame)
      return 0;
    CIImage *image = [CIImage imageWithIOSurface:frame.surface];
    CIContext *context = [CIContext contextWithOptions:nil];
    CGImageRef cg = [context createCGImage:image fromRect:image.extent];
    if (!cg)
      return 0;
    NSData *png = [[[NSBitmapImageRep alloc] initWithCGImage:cg]
        representationUsingType:NSBitmapImageFileTypePNG
                     properties:@{}];
    CGImageRelease(cg);
    if (!png.length)
      return 0;
    *length = png.length;
    *bytes = malloc(*length);
    if (!*bytes)
      return 0;
    memcpy(*bytes, png.bytes, *length);
    return 1;
  }
}
void vitre_mobile_free(void *p) { free(p); }
bool vitre_mobile_text(void *handle, const char *text) {
  VitreMobileView *v = (__bridge VitreMobileView *)handle;
  typedef void *(*KeyboardBuilder)(int, int);
  KeyboardBuilder builder = (KeyboardBuilder)dlsym(
      RTLD_DEFAULT, "IndigoHIDMessageForKeyboardArbitrary");
  if (!v->modernHID && (!builder || !v->hid))
    return false;
  NSString *characters = [NSString stringWithUTF8String:text];
  for (NSUInteger i = 0; i < characters.length; i++)
    if ([characters characterAtIndex:i] > 127)
      return false;
  dispatch_async(v->inputQueue, ^{
    for (NSUInteger i = 0; i < characters.length; i++) {
      unichar c = [characters characterAtIndex:i];
      int usage = 0;
      BOOL shift = NO;
      if (c >= 'a' && c <= 'z')
        usage = c - 'a' + 4;
      else if (c >= 'A' && c <= 'Z') {
        usage = c - 'A' + 4;
        shift = YES;
      } else if (c >= '1' && c <= '9')
        usage = c - '1' + 30;
      else if (c == '0')
        usage = 39;
      else if (c == '\r' || c == '\n')
        usage = 40;
      else if (c == 127 || c == 8)
        usage = 42;
      else if (c == 27)
        usage = 41;
      else if (c == '\t')
        usage = 43;
      else if (c == ' ')
        usage = 44;
      else if (c == '`' || c == '~') {
        usage = 53;
        shift = c == '~';
      } else {
        NSString *plain = @"-=[]\\;'/,.";
        NSString *shifted = @"_+{}|:\"?<>!@#$%^&*()";
        NSRange r = [plain rangeOfString:[NSString stringWithCharacters:&c
                                                                 length:1]];
        const int codes[] = {45, 46, 47, 48, 49, 51, 52, 56, 54, 55};
        if (r.location != NSNotFound)
          usage = codes[r.location];
        else {
          r = [shifted rangeOfString:[NSString stringWithCharacters:&c
                                                             length:1]];
          const int shiftedCodes[] = {45, 46, 47, 48, 49, 51, 52, 56, 54, 55,
                                      30, 31, 32, 33, 34, 35, 36, 37, 38, 39};
          if (r.location != NSNotFound) {
            usage = shiftedCodes[r.location];
            shift = YES;
          }
        }
      }
      if (!usage)
        continue;
      int codes[4] = {shift ? 225 : usage, usage, usage, 225};
      int dirs[4] = {1, 1, 2, 2};
      for (int j = shift ? 0 : 1; j < (shift ? 4 : 3); j++) {
        if (v->modernHID)
          xpc_connection_send_message(
              v->modernHID, keyboardMessage(codes[j], dirs[j], false));
        else
          @try {
            [v->hid sendWithMessage:builder(codes[j], dirs[j])
                       freeWhenDone:YES
                    completionQueue:v->inputQueue
                         completion:^(NSError *e){
                         }];
          } @catch (NSException *e) {
          }
      }
    }
  });
  return true;
}
