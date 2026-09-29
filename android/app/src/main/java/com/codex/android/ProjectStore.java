package com.codex.android;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** App-private project store. Each project is isolated under files/projects/<id>. */
final class ProjectStore {
    private final File root;
    ProjectStore(Context context) { root = new File(context.getFilesDir(), "projects"); root.mkdirs(); }

    synchronized JSONArray list() throws JSONException {
        JSONArray out = new JSONArray();
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs == null) return out;
        for (File d : dirs) {
            File m = new File(d, "project.json");
            if (m.isFile()) { try { out.put(new JSONObject(read(m))); } catch (Exception e) {} }
        }
        return out;
    }

    synchronized JSONObject create(String name, String type) throws Exception {
        String id = UUID.randomUUID().toString();
        File dir = new File(root, id);
        if (!dir.mkdirs()) throw new IOException("Unable to create project workspace");
        File src = new File(dir, "src");
        if (!src.mkdirs()) throw new IOException("Unable to create source workspace");
        JSONObject p = new JSONObject();
        p.put("id", id); p.put("name", name); p.put("type", type);
        p.put("sourcePath", src.getAbsolutePath()); p.put("createdAt", System.currentTimeMillis());
        p.put("updatedAt", System.currentTimeMillis());
        p.put("networkPermission", false);
        write(new File(dir, "project.json"), p.toString(2));
        return p;
    }

    synchronized File sourceDir(String id) throws IOException {
        File dir = new File(root, id);
        File canonicalRoot = root.getCanonicalFile();
        File canonical = new File(dir, "src").getCanonicalFile();
        String r = canonicalRoot.getPath() + File.separator;
        if (!canonical.getPath().startsWith(r)) throw new SecurityException("Workspace escape");
        if (!canonical.isDirectory()) throw new FileNotFoundException("Project workspace not found");
        return canonical;
    }

    synchronized String tree(String id) throws Exception { return tree(sourceDir(id), ""); }
    private String tree(File dir, String prefix) {
        StringBuilder b = new StringBuilder(); File[] files = dir.listFiles();
        if (files == null) return "";
        Arrays.sort(files, Comparator.comparing(File::getName));
        for (File f : files) { b.append(prefix).append(f.isDirectory()?"📁 ":"📄 ").append(f.getName()).append('\n'); if (f.isDirectory()) b.append(tree(f,prefix+"  ")); }
        return b.toString();
    }

    static String read(File f) throws IOException { return new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
    static void write(File f, String s) throws IOException { try(FileOutputStream o=new FileOutputStream(f)){o.write(s.getBytes(StandardCharsets.UTF_8));} }
}
