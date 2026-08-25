use crate::error::AppError;
use std::fs::File;
use std::path::Path;
use symphonia::core::codecs::CODEC_TYPE_NULL;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub fn duration_ms(path: &Path) -> Result<u64, AppError> {
    let file = File::open(path).map_err(|e| AppError::from(format!("无法打开音频：{e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| AppError::from(format!("无法识别音频格式：{e}")))?;
    let format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| AppError::from("音频文件没有可解码轨道"))?;
    let params = &track.codec_params;
    if let (Some(frames), Some(rate)) = (params.n_frames, params.sample_rate) {
        if rate > 0 {
            return Ok((frames as u128 * 1000 / rate as u128) as u64);
        }
    }
    if let Some(tb) = params.time_base {
        if let Some(frames) = params.n_frames {
            let time = tb.calc_time(frames);
            return Ok(time.seconds * 1000 + (time.frac * 1000.0) as u64);
        }
    }
    Err(AppError::from("无法读取音频时长"))
}

/// Downsampled peak envelope for the calibrator timeline. 2000 buckets is enough
/// to draw a 30-minute track without shipping PCM to the frontend.
pub fn waveform_peaks(path: &Path, buckets: usize) -> Result<(u64, Vec<f32>), AppError> {
    let duration = duration_ms(path)?;
    let file = File::open(path).map_err(|e| AppError::from(format!("无法打开音频：{e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| AppError::from(format!("无法识别音频格式：{e}")))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| AppError::from("音频文件没有可解码轨道"))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &Default::default())
        .map_err(|e| AppError::from(format!("无法解码音频：{e}")))?;
    let buckets = buckets.max(64);
    let mut peaks = vec![0.0f32; buckets];
    let mut samples_seen = 0u64;
    let rate = track.codec_params.sample_rate.unwrap_or(44100) as u64;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1).max(1) as u64;
    let total_samples = (duration.max(1) * rate / 1000).max(1);
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(_) => continue,
        };
        let spec = *decoded.spec();
        let mut sample_buf =
            symphonia::core::audio::SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let ch = spec.channels.count().max(1);
        let data = sample_buf.samples();
        for frame in data.chunks(ch) {
            let mut peak = 0.0f32;
            for s in frame {
                peak = peak.max(s.abs());
            }
            let idx = ((samples_seen * buckets as u64) / total_samples).min(buckets as u64 - 1) as usize;
            if peak > peaks[idx] {
                peaks[idx] = peak;
            }
            samples_seen += 1;
        }
        let _ = channels;
    }
    Ok((duration, peaks))
}
