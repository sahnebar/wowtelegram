// JXA, executed by macOS osascript. Reads public app metadata; no screen capture or game memory.
ObjC.import('AppKit');
ObjC.import('Foundation');
var previous = '';
while (true) {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var info = {
    pid: Number(app.processIdentifier),
    bundle: ObjC.unwrap(app.bundleIdentifier) || '',
    name: ObjC.unwrap(app.localizedName) || '',
    path: ObjC.unwrap(app.executableURL.path) || ''
  };
  var line = JSON.stringify(info);
  if (line !== previous) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    previous = line;
  }
  $.NSThread.sleepForTimeInterval(1);
}
