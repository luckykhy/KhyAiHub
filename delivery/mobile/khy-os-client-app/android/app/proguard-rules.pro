# proguard-rules.pro — khy-os client app
#
# WHY this file exists. The release build runs R8 (AGP 9.x enables it by
# default), which renames and strips classes by reachability from the app's
# entry points. One class in this app is deliberately NOT reachable from any
# entry point: the shell sidecar is started from outside the app, by adb, as
#
#   adb shell dalvikvm -cp <dex> com.khyos.khy_os_client.shell.ShellSidecar
#
# R8 has no way to know that. Without the keep rule below it would rename the
# class (dalvikvm resolves it by name, so the sidecar would simply never start)
# or strip it outright (nothing in the app references it). Either failure is
# silent from the app's side: exec just falls back to the app's own uid and the
# overlay says "未提权", which looks exactly like "nobody provisioned it".
#
# Keep the rule narrow. A blanket -keep for the whole bridge package would
# throw away R8's size work for the sake of one entry point.

# The sidecar entry point: name and members must survive.
-keep class com.khyos.khy_os_client.shell.ShellSidecar { *; }

# Its one dependency. Referenced by compiled bytecode so renaming it would be
# consistent — but it is the token shape rule, and a rename here buys nothing
# while making the dex harder to read when debugging a provisioning failure.
-keep class com.khyos.khy_os_client.bridge.BridgeToken { *; }
