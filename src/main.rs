use std::env;
use topcoat::{
    Result,
    router::{Router, RouterBuilderDiscoverExt, content::Json, route},
};

#[tokio::main]
async fn main() -> Result<()> {
    if let Ok(port) = env::var("AIO_PLUGIN_PORT") {
        // AIO 进程入口由宿主分配，不新增插件监听配置。
        unsafe { env::set_var("PORT", port) };
    }
    if let Ok(path) = env::var("AIO_PLUGIN_SOCKET") {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = std::path::PathBuf::from(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let listener = tokio::net::UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))?;
            topcoat::serve(listener, router()).await?;
            return Ok(());
        }
    }
    topcoat::start(router()).await?;
    Ok(())
}

fn router() -> Router {
    Router::builder().discover().build()
}

#[route(GET "/health")]
async fn health() -> Result<&'static str> {
    Ok("ok")
}

#[route(GET "/aio/describe")]
async fn describe() -> Result<Json<serde_json::Value>> {
    Ok(Json(serde_json::json!({
        "label": "Codex Buddy",
        "pages": [{"id": "codex", "label": "Codex Buddy", "entry": "index.html", "scene": ["workspace", "工作空间"], "menu_path": ["Codex Buddy"], "permission": null, "surface": "workspace"}]
    })))
}
