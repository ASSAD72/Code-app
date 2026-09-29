package com.codex.android;

import java.io.*;
import java.util.concurrent.TimeUnit;

/**
 * Android sandbox provider for CodeX. Commands run from an app-private project
 * directory. No command may change cwd outside that workspace.
 *
 * This is intentionally separate from the Desktop Docker/WSL providers so the
 * same Core concepts can later be selected by a platform provider registry.
 */
final class AndroidSandbox {
    static final class Result { int exitCode; String output; boolean timedOut; }
    Result exec(File workspace, String command, long timeoutMs) throws Exception {
        if (!workspace.isDirectory()) throw new IOException("Workspace unavailable");
        Process p = new ProcessBuilder("/system/bin/sh", "-c", command).directory(workspace).redirectErrorStream(true).start();
        StringBuilder out = new StringBuilder();
        Thread reader = new Thread(() -> { try(BufferedReader r=new BufferedReader(new InputStreamReader(p.getInputStream()))){String line; while((line=r.readLine())!=null) out.append(line).append('\n');}catch(IOException ignored){} });
        reader.start();
        Result result = new Result();
        if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) { result.timedOut=true; p.destroy(); if(!p.waitFor(500,TimeUnit.MILLISECONDS)) p.destroyForcibly(); result.exitCode=124; }
        else result.exitCode=p.exitValue();
        reader.join(1000); result.output=out.toString(); return result;
    }
}
