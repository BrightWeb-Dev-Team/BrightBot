import ctypes
import sys
import time

cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]

cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CFRelease.argtypes = [ctypes.c_void_p]
cg.CGEventSetIntegerValueField.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64]

TAP = 0
LEFT_DOWN = 1
LEFT_UP = 2
RIGHT_DOWN = 3
RIGHT_UP = 4
MOUSE_MOVED = 5
CLICK_STATE = 1

def post_mouse(event_type, x, y, button=0, click_state=1):
    event = cg.CGEventCreateMouseEvent(None, event_type, CGPoint(x, y), button)
    if not event:
        raise RuntimeError('failed to create mouse event')
    cg.CGEventSetIntegerValueField(event, CLICK_STATE, click_state)
    cg.CGEventPost(TAP, event)
    cg.CFRelease(event)

action = sys.argv[1]
x = float(sys.argv[2]) if len(sys.argv) > 2 else 0
y = float(sys.argv[3]) if len(sys.argv) > 3 else 0

if action == 'move':
    post_mouse(MOUSE_MOVED, x, y)
elif action in ('click', 'double_click', 'right_click'):
    button = 1 if action == 'right_click' else 0
    down = RIGHT_DOWN if button else LEFT_DOWN
    up = RIGHT_UP if button else LEFT_UP
    count = 2 if action == 'double_click' else 1
    for index in range(count):
        state = index + 1 if count == 2 else 1
        post_mouse(down, x, y, button, state)
        post_mouse(up, x, y, button, state)
        time.sleep(0.08)
elif action == 'scroll':
    post_mouse(MOUSE_MOVED, x, y)
    delta = int(float(sys.argv[4]))
    event = cg.CGEventCreateScrollWheelEvent(None, 0, 1, delta)
    if not event:
        raise RuntimeError('failed to create scroll event')
    cg.CGEventPost(TAP, event)
    cg.CFRelease(event)
else:
    raise RuntimeError(f'unknown action: {action}')
