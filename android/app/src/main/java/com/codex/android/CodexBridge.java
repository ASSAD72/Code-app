package com.codex.android;

import android.webkit.JavascriptInterface;
import android.content.Context;
import org.json.*;

final class CodexBridge {
    private final ProjectStore projects; private final AndroidSandbox sandbox; private final SyncManager sync;
    CodexBridge(Context c){ projects=new ProjectStore(c); sandbox=new AndroidSandbox(); sync=new SyncManager(c); }

    @JavascriptInterface public String dashboard() { try { JSONObject o=new JSONObject(); o.put("projects",projects.list().length()); o.put("sandbox","android-app-private"); o.put("sync",sync.status()); return o.toString(); } catch(Exception e){return err(e);} }
    @JavascriptInterface public String listProjects(){ try{return projects.list().toString();}catch(Exception e){return "[]";} }
    @JavascriptInterface public String createProject(String name,String type){try{return projects.create(name,type).toString();}catch(Exception e){return err(e);}}
    @JavascriptInterface public String tree(String id){try{return projects.tree(id);}catch(Exception e){return "ERROR: "+e.getMessage();}}
    @JavascriptInterface public String run(String id,String command){try{AndroidSandbox.Result r=sandbox.exec(projects.sourceDir(id),command,120000); JSONObject o=new JSONObject();o.put("exitCode",r.exitCode);o.put("timedOut",r.timedOut);o.put("output",r.output);return o.toString();}catch(Exception e){return err(e);}}
    @JavascriptInterface public String capabilities(){return "{\"provider\":\"android\",\"filesystem\":true,\"process\":true,\"network\":false,\"gpu\":false,\"usb\":false,\"kvm\":false}";}
    @JavascriptInterface public String syncStatus(){return sync.status();}
    private String err(Exception e){try{return new JSONObject().put("error",e.getMessage()==null?e.toString():e.getMessage()).toString();}catch(Exception x){return "{\"error\":\"unknown\"}";}}
}
