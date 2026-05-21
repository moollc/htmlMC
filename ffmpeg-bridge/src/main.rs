use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

struct Session {
    child:      Child,
    stdin:      std::process::ChildStdin,
    stderr:     ChildStderr,
    output_dir: PathBuf,
}

type SharedState = Arc<Mutex<Option<Session>>>;

#[derive(Deserialize)]
struct StartPayload {
    width:  u32,
    height: u32,
    fps:    u32,
    format: String,
    audio_path:   Option<String>,
    audio_offset: Option<f32>,
}

#[derive(Serialize)]
struct StartResponse {
    output_dir: String,
}

#[derive(Serialize)]
struct EndResponse {
    output:      String,
    ffmpeg_log:  String,
}

#[tokio::main]
async fn main() {
    let state: SharedState = Arc::new(Mutex::new(None));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    let app = Router::new()
        .route("/export/start", post(handle_start))
        .route("/export/frame", post(handle_frame))
        .route("/export/end",   post(handle_end))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8791").await.unwrap();
    println!("[bridge] listening on http://127.0.0.1:8791");
    axum::serve(listener, app).await.unwrap();
}

async fn handle_start(
    State(state): State<SharedState>,
    Json(payload): Json<StartPayload>,
) -> impl IntoResponse {
    println!(
        "[bridge] /export/start — {}×{} @ {}fps format={}",
        payload.width, payload.height, payload.fps, payload.format
    );

    let mut lock = state.lock().await;

    // Clean up any hanging previous session
    if let Some(mut old) = lock.take() {
        println!("[bridge] cleaning up previous session");
        drop(old.stdin);
        let _ = old.child.wait();
    }

    // Output directory relative to cwd
    let mut output_dir = std::env::current_dir().unwrap();
    output_dir.push("output");
    output_dir.push("test_export");
    fs::create_dir_all(&output_dir).expect("failed to create output dir");
    println!("[bridge] output → {}", output_dir.display());

    // Prefer FFMPEG_PATH env var, fall back to system PATH
    let ffmpeg_bin = if let Ok(custom_path) = std::env::var("FFMPEG_PATH") {
        println!("[bridge] using FFMPEG_PATH: {}", custom_path);
        custom_path
    } else {
        println!("[bridge] using system ffmpeg from PATH");
        "ffmpeg".to_string()
    };

    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-y")
       .arg("-f").arg("rawvideo")
       .arg("-pix_fmt").arg("rgba")
       .arg("-s").arg(format!("{}x{}", payload.width, payload.height))
       .arg("-r").arg(payload.fps.to_string())
       .arg("-i").arg("pipe:0");

    if let Some(ref path) = payload.audio_path {
        cmd.arg("-i").arg(path);
    }

    // Audio Routing & Delay Alignment
    if payload.audio_path.is_some() {
        let offset_ms = (payload.audio_offset.unwrap_or(0.0) * 1000.0) as i32;

        if offset_ms > 0 {
            cmd.arg("-filter_complex")
               .arg(format!("[1:a]adelay={}|{}[delayed_audio]", offset_ms, offset_ms))
               .arg("-map").arg("0:v:0")
               .arg("-map").arg("[delayed_audio]");
        } else if offset_ms < 0 {
            let start_seek = offset_ms.abs() as f32 / 1000.0;
            cmd.arg("-ss").arg(start_seek.to_string())
               .arg("-map").arg("0:v:0")
               .arg("-map").arg("1:a:0");
        } else {
            cmd.arg("-map").arg("0:v:0")
               .arg("-map").arg("1:a:0");
        }

        if payload.format == "prores" {
            cmd.arg("-c:a").arg("pcm_s16le");
        } else {
            cmd.arg("-c:a").arg("aac");
        }
    }

    if payload.format == "prores" {
        cmd.arg("-c:v").arg("prores_ks")
           .arg("-profile:v").arg("4444")
           .arg("-pix_fmt").arg("yuva444p10le")
           .arg(output_dir.join("output.mov"));
    } else if payload.format == "mp4" {
        cmd.arg("-c:v").arg("libx264")
           .arg("-pix_fmt").arg("yuv420p")
           .arg(output_dir.join("output.mp4"));
    } else {
        cmd.arg(output_dir.join("frame_%04d.png"));
    }

    cmd.stdin(Stdio::piped())
       .stdout(Stdio::null())
       .stderr(Stdio::piped());

    match cmd.spawn() {
        Ok(mut child) => {
            let stdin  = child.stdin.take().expect("failed to get stdin");
            let stderr = child.stderr.take().expect("failed to get stderr");
            let output_dir_str = output_dir.to_string_lossy().to_string();

            *lock = Some(Session { child, stdin, stderr, output_dir });

            (StatusCode::OK, Json(StartResponse { output_dir: output_dir_str })).into_response()
        }
        Err(e) => {
            eprintln!("[bridge] failed to spawn ffmpeg: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, format!("ffmpeg spawn failed: {}", e)).into_response()
        }
    }
}

async fn handle_frame(
    State(state): State<SharedState>,
    body: Bytes,
) -> impl IntoResponse {
    let mut lock = state.lock().await;

    if let Some(session) = lock.as_mut() {
        if let Err(e) = session.stdin.write_all(&body) {
            eprintln!("[bridge] stdin write error: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("pipe write failed: {}", e)).into_response();
        }
        let _ = session.stdin.flush();
        (StatusCode::OK, Json(serde_json::json!({}))).into_response()
    } else {
        eprintln!("[bridge] /export/frame called with no active session");
        (StatusCode::BAD_REQUEST, "no active session — call /export/start first").into_response()
    }
}

async fn handle_end(State(state): State<SharedState>) -> impl IntoResponse {
    println!("[bridge] /export/end — finalizing");

    let mut lock = state.lock().await;

    if let Some(mut session) = lock.take() {
        drop(session.stdin);

        let exit_status = match session.child.wait() {
            Ok(s)  => s,
            Err(e) => {
                eprintln!("[bridge] ffmpeg wait error: {}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, format!("ffmpeg wait failed: {}", e)).into_response();
            }
        };

        let mut ffmpeg_log = String::new();
        let _ = session.stderr.read_to_string(&mut ffmpeg_log);

        if !ffmpeg_log.is_empty() {
            println!("[bridge] ffmpeg stderr:\n{}", ffmpeg_log);
        }

        if exit_status.success() {
            println!("[bridge] ffmpeg exited cleanly");
        } else {
            eprintln!("[bridge] ffmpeg exited with status: {}", exit_status);
            if !ffmpeg_log.is_empty() {
                eprintln!("[bridge] ffmpeg log:\n{}", ffmpeg_log);
            }
        }

        let output_dir_str = session.output_dir.to_string_lossy().to_string();

        (StatusCode::OK, Json(EndResponse {
            output:     output_dir_str,
            ffmpeg_log: ffmpeg_log.lines().rev().take(10).collect::<Vec<_>>().join("\n"),
        })).into_response()
    } else {
        eprintln!("[bridge] /export/end called with no active session");
        (StatusCode::BAD_REQUEST, "no active session to end").into_response()
    }
}
