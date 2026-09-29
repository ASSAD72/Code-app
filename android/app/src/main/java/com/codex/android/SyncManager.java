package com.codex.android;

import android.content.Context;
import java.security.MessageDigest;

/** Future-ready sync boundary. It intentionally contains no server assumptions. */
final class SyncManager {
    private final Context context;
    SyncManager(Context context) { this.context=context; }
    String deviceId() throws Exception {
        byte[] data = context.getPackageName().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder b=new StringBuilder(); for(byte x:hash)b.append(String.format("%02x",x)); return b.toString();
    }
    String status() { return "local-first; remote sync endpoint not configured"; }
}
