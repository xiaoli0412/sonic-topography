use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: u16 = 2;
const CHUNK_DURATION_MS: usize = 200;
const CHUNK_SAMPLES: usize =
    TARGET_SAMPLE_RATE as usize * CHUNK_DURATION_MS / 1000 * TARGET_CHANNELS as usize;

const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_values(
    0x00000001,
    0x0000,
    0x0010,
    [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],
);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID = GUID::from_values(
    0x00000003,
    0x0000,
    0x0010,
    [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],
);

struct CaptureState {
    running: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
}

impl CaptureState {
    fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
        }
    }

    fn reset(&mut self) {
        self.capture_thread = None;
        self.running.store(false, Ordering::SeqCst);
    }
}

static CAPTURE_STATE: Lazy<Mutex<CaptureState>> = Lazy::new(|| Mutex::new(CaptureState::new()));

/// Parses the WAVEFORMATEX returned by WASAPI and returns (sample_rate, channels, converter).
unsafe fn make_format_converter(
    pwf: *const WAVEFORMATEX,
) -> Result<(u32, u16, Box<dyn Fn(&[u8]) -> Vec<f32> + Send>), String> {
    if pwf.is_null() {
        return Err("Null WAVEFORMATEX from device".to_string());
    }

    let wf = &*pwf;
    let sample_rate = wf.nSamplesPerSec;
    let channels = wf.nChannels;

    let format_tag = wf.wFormatTag;
    let bits_per_sample = wf.wBitsPerSample;

    let is_float = if format_tag == WAVE_FORMAT_PCM as u16 {
        false
    } else if format_tag == WAVE_FORMAT_IEEE_FLOAT {
        true
    } else if format_tag == WAVE_FORMAT_EXTENSIBLE {
        let wfe = &*(pwf as *const WAVEFORMATEXTENSIBLE);
        let sub_format = wfe.SubFormat;
        if sub_format == KSDATAFORMAT_SUBTYPE_PCM {
            false
        } else if sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            true
        } else {
            return Err(format!("Unsupported EXTENSIBLE sub-format: {:?}", sub_format));
        }
    } else {
        return Err(format!("Unsupported WAVEFORMATEX format tag: {}", format_tag));
    };

    if is_float {
        if bits_per_sample != 32 {
            return Err(format!("Unsupported float bit depth: {}", bits_per_sample));
        }
        Ok((
            sample_rate,
            channels,
            Box::new(move |input: &[u8]| {
                let samples = input.len() / 4;
                let mut output = Vec::with_capacity(samples);
                for i in 0..samples {
                    let bytes = &input[i * 4..(i + 1) * 4];
                    let f = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                    output.push(f.clamp(-1.0, 1.0));
                }
                output
            }),
        ))
    } else {
        match bits_per_sample {
            8 => Ok((
                sample_rate,
                channels,
                Box::new(move |input: &[u8]| {
                    input
                        .iter()
                        .map(|&b| ((b as i16 - 128) as f32 / 128.0).clamp(-1.0, 1.0))
                        .collect()
                }),
            )),
            16 => Ok((
                sample_rate,
                channels,
                Box::new(move |input: &[u8]| {
                    let samples = input.len() / 2;
                    let mut output = Vec::with_capacity(samples);
                    for i in 0..samples {
                        let bytes = &input[i * 2..(i + 1) * 2];
                        let s = i16::from_le_bytes([bytes[0], bytes[1]]);
                        output.push((s as f32 / 32768.0).clamp(-1.0, 1.0));
                    }
                    output
                }),
            )),
            24 => Ok((
                sample_rate,
                channels,
                Box::new(move |input: &[u8]| {
                    let samples = input.len() / 3;
                    let mut output = Vec::with_capacity(samples);
                    for i in 0..samples {
                        let bytes = &input[i * 3..(i + 1) * 3];
                        let signed =
                            (bytes[0] as i32 | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16))
                                << 8;
                        let s = (signed >> 16) as i32;
                        output.push((s as f32 / 8388608.0).clamp(-1.0, 1.0));
                    }
                    output
                }),
            )),
            32 => Ok((
                sample_rate,
                channels,
                Box::new(move |input: &[u8]| {
                    let samples = input.len() / 4;
                    let mut output = Vec::with_capacity(samples);
                    for i in 0..samples {
                        let bytes = &input[i * 4..(i + 1) * 4];
                        let s = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                        output.push((s as f32 / 2147483648.0).clamp(-1.0, 1.0));
                    }
                    output
                }),
            )),
            _ => Err(format!("Unsupported PCM bit depth: {}", bits_per_sample)),
        }
    }
}

/// Resample interleaved f32 input to 48 kHz stereo output.
fn resample_to_target(input: &[f32], src_rate: u32, src_channels: u16) -> Vec<f32> {
    let src_channels = src_channels.max(1) as usize;
    let src_frames = input.len() / src_channels;
    if src_frames == 0 {
        return Vec::new();
    }

    let out_channels = TARGET_CHANNELS as usize;
    let ratio = src_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let out_frames = ((src_frames as f64 / ratio) as usize).max(1);

    let mut output = Vec::with_capacity(out_frames * out_channels);

    for out_frame in 0..out_frames {
        let src_pos = out_frame as f64 * ratio;
        let idx0 = src_pos.floor() as usize;
        let idx1 = (idx0 + 1).min(src_frames.saturating_sub(1));
        let frac = (src_pos - idx0 as f64) as f32;

        for ch in 0..out_channels {
            let src_ch = ch.min(src_channels - 1);
            let s0 = input[idx0 * src_channels + src_ch];
            let s1 = input[idx1 * src_channels + src_ch];
            let sample = s0 + (s1 - s0) * frac;
            output.push(sample.clamp(-1.0, 1.0));
        }
    }

    output
}

/// Emit a chunk of interleaved stereo f32 samples as a base64 string event.
fn emit_chunk(app_handle: &AppHandle, chunk: &[f32]) {
    if chunk.is_empty() {
        return;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(chunk.as_ptr() as *const u8, chunk.len() * 4)
    };
    let encoded = STANDARD.encode(bytes);
    let _ = app_handle.emit("audio-capture-data", encoded);
}

/// Captures the default render endpoint in loopback mode and pushes PCM chunks.
unsafe fn run_capture(
    app_handle: AppHandle,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    CoInitializeEx(None, COINIT_MULTITHREADED)
        .ok()
        .map_err(|e| format!("CoInitializeEx failed: {:?}", e))?;

    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| format!("CoCreateInstance(MMDeviceEnumerator) failed: {:?}", e))?;

    let device: IMMDevice = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("GetDefaultAudioEndpoint failed: {:?}", e))?;

    let audio_client: IAudioClient = device
        .Activate::<IAudioClient>(CLSCTX_ALL, None)
        .map_err(|e| format!("Activate(IAudioClient) failed: {:?}", e))?;

    let mix_format = audio_client
        .GetMixFormat()
        .map_err(|e| format!("GetMixFormat failed: {:?}", e))?;

    let (sample_rate, channels, converter) = make_format_converter(mix_format)?;

    let hns_buffer_duration = 10_000_000i64; // 1 second in hundred-nanoseconds
    audio_client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            hns_buffer_duration,
            0,
            mix_format,
            None,
        )
        .map_err(|e| format!("IAudioClient::Initialize failed: {:?}", e))?;

    let capture_client: IAudioCaptureClient = audio_client
        .GetService()
        .map_err(|e| format!("GetService(IAudioCaptureClient) failed: {:?}", e))?;

    audio_client
        .Start()
        .map_err(|e| format!("IAudioClient::Start failed: {:?}", e))?;

    let sleep_duration = Duration::from_millis((hns_buffer_duration as u64 / 10_000) / 4);
    let mut accumulator: Vec<f32> = Vec::new();

    while running.load(Ordering::Relaxed) {
        thread::sleep(sleep_duration);

        let mut packet_length = match capture_client.GetNextPacketSize() {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[audio_capture] GetNextPacketSize error: {:?}", e);
                break;
            }
        };

        while packet_length != 0 {
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames_available = 0u32;
            let mut flags = 0u32;

            match capture_client.GetBuffer(
                &mut data,
                &mut frames_available,
                &mut flags,
                None,
                None,
            ) {
                Ok(_) => {
                    if !data.is_null() && frames_available > 0 {
                        let byte_count = (frames_available as usize)
                            * (channels as usize)
                            * ((*mix_format).wBitsPerSample as usize / 8);
                        let slice = std::slice::from_raw_parts(data, byte_count);
                        let input_samples = converter(slice);
                        let output_samples =
                            resample_to_target(&input_samples, sample_rate, channels);
                        accumulator.extend_from_slice(&output_samples);
                    }

                    while accumulator.len() >= CHUNK_SAMPLES {
                        let chunk: Vec<f32> = accumulator.drain(..CHUNK_SAMPLES).collect();
                        emit_chunk(&app_handle, &chunk);
                    }

                    if let Err(e) = capture_client.ReleaseBuffer(frames_available) {
                        eprintln!("[audio_capture] ReleaseBuffer error: {:?}", e);
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[audio_capture] GetBuffer error: {:?}", e);
                    break;
                }
            }

            packet_length = match capture_client.GetNextPacketSize() {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[audio_capture] GetNextPacketSize error: {:?}", e);
                    break;
                }
            };
        }
    }

    let _ = audio_client.Stop();

    // Flush any remaining samples as a final (possibly smaller) chunk.
    if !accumulator.is_empty() {
        emit_chunk(&app_handle, &accumulator);
    }

    Ok(())
}

pub fn start(app_handle: AppHandle) -> Result<(), String> {
    let mut state = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
    if state.running.load(Ordering::Relaxed) {
        return Ok(());
    }

    let running = Arc::new(AtomicBool::new(true));
    let running_capture = running.clone();

    let capture_thread = thread::spawn(move || {
        if let Err(e) = unsafe { run_capture(app_handle, running_capture) } {
            eprintln!("[audio_capture] capture thread error: {}", e);
        }
    });

    state.running.store(true, Ordering::SeqCst);
    state.capture_thread = Some(capture_thread);

    Ok(())
}

pub fn stop() -> Result<(), String> {
    let mut state = CAPTURE_STATE.lock().map_err(|e| e.to_string())?;
    if !state.running.load(Ordering::Relaxed) {
        return Ok(());
    }

    state.running.store(false, Ordering::SeqCst);

    if let Some(handle) = state.capture_thread.take() {
        let _ = handle.join();
    }

    state.reset();
    Ok(())
}
