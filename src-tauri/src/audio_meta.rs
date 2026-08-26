use crate::error::AppError;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

/// WAVE_FORMAT_MPEG / MPEG Layer-3 in a RIFF container.
const WAVE_FORMAT_MPEG: u16 = 0x0050;
const WAVE_FORMAT_MPEGLAYER3: u16 = 0x0055;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sniff {
    Mp3,
    M4a,
    WavPcm,
    MpegInWav { data_offset: usize, data_len: usize },
    Unsupported(String),
}

pub fn sniff(path: &Path) -> Result<Sniff, AppError> {
    let bytes = fs::read(path).map_err(|e| AppError::from(format!("无法读取音频：{e}")))?;
    sniff_bytes(&bytes, path)
}

fn sniff_bytes(bytes: &[u8], path: &Path) -> Result<Sniff, AppError> {
    if bytes.len() < 12 {
        return Ok(Sniff::Unsupported("文件太小，不是可识别的音频".into()));
    }
    if bytes.starts_with(b"ID3") || is_mpeg_frame(bytes) {
        return Ok(Sniff::Mp3);
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Ok(Sniff::M4a);
    }
    if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WAVE" {
        return Ok(sniff_wav(bytes));
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let reason = match ext.as_str() {
        "flac" => "FLAC 不受支持，请提供 MP3 / M4A / WAV",
        "ogg" | "oga" => "OGG 不受支持，请提供 MP3 / M4A / WAV",
        "wma" => "WMA 不受支持，请提供 MP3 / M4A / WAV",
        "aac" => "裸 AAC 不受支持，请提供 M4A 或 MP3",
        "wav" => "无法识别的 WAV 编码",
        _ => "无法识别的音频格式，仅支持 MP3、M4A、WAV",
    };
    Ok(Sniff::Unsupported(reason.into()))
}

fn is_mpeg_frame(bytes: &[u8]) -> bool {
    if bytes.len() < 2 {
        return false;
    }
    bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0
}

fn sniff_wav(bytes: &[u8]) -> Sniff {
    let mut i = 12usize;
    let mut format = 0u16;
    let mut data_offset = None;
    let mut data_len = 0usize;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap_or([0; 4])) as usize;
        let body = i + 8;
        if id == b"fmt " && body + 2 <= bytes.len() {
            format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
        }
        if id == b"data" {
            data_offset = Some(body);
            data_len = size.min(bytes.len().saturating_sub(body));
        }
        let step = 8 + size;
        i = i.saturating_add(step + step % 2);
        if step == 0 {
            break;
        }
    }
    if let Some(off) = data_offset {
        let head = &bytes[off..off.saturating_add(4).min(bytes.len())];
        if format == WAVE_FORMAT_MPEG || format == WAVE_FORMAT_MPEGLAYER3 || is_mpeg_frame(head) {
            return Sniff::MpegInWav {
                data_offset: off,
                data_len,
            };
        }
        if format == 1 {
            return Sniff::WavPcm;
        }
        return Sniff::Unsupported(format!(
            "WAV 编码 0x{format:04X} 不受支持（不是 PCM 或 MPEG），请提供 MP3 / M4A / PCM WAV"
        ));
    }
    Sniff::Unsupported("WAV 缺少 data 块".into())
}

/// Copy MPEG payload out of a WAV wrapper without transcoding. Returns the new path.
pub fn extract_mpeg_from_wav(src: &Path, dest_dir: &Path) -> Result<PathBuf, AppError> {
    let bytes = fs::read(src).map_err(|e| AppError::from(format!("无法读取音频：{e}")))?;
    match sniff_bytes(&bytes, src)? {
        Sniff::MpegInWav {
            data_offset,
            data_len,
        } => {
            fs::create_dir_all(dest_dir)?;
            let dest = dest_dir.join(format!(
                "{}.mp3",
                src.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("extracted")
            ));
            let end = data_offset.saturating_add(data_len).min(bytes.len());
            let mut f = File::create(&dest)?;
            f.write_all(&bytes[data_offset..end])?;
            f.sync_all()?;
            Ok(dest)
        }
        Sniff::Mp3 => Ok(src.to_path_buf()),
        other => Err(AppError::from(format!(
            "不是可拆取的 MPEG-in-WAV：{other:?}"
        ))),
    }
}

pub fn format_label(sniff: &Sniff) -> &'static str {
    match sniff {
        Sniff::Mp3 => "mp3",
        Sniff::M4a => "m4a",
        Sniff::WavPcm => "wav",
        Sniff::MpegInWav { .. } => "mp3",
        Sniff::Unsupported(_) => "unknown",
    }
}
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn mpeg_wav(payload: &[u8]) -> Vec<u8> {
        let data_len = payload.len() as u32;
        let riff_size = 4 + (8 + 16) + (8 + data_len);
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&riff_size.to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&0x0055u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&44100u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn detects_mpeg_in_wav_and_extracts_payload() {
        let payload = [0xFF, 0xE3, 0x20, 0xC4, 0x00, 0x12, 0x39, 0x41];
        let wav = mpeg_wav(&payload);
        let sniff = sniff_bytes(&wav, Path::new("x.wav")).unwrap();
        assert!(matches!(sniff, Sniff::MpegInWav { .. }));
        let dir = env::temp_dir().join(format!("ielts-wav-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let src = dir.join("part.wav");
        fs::write(&src, &wav).unwrap();
        let dest = extract_mpeg_from_wav(&src, &dir.join("out")).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), payload);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn id3_is_mp3_even_with_wav_extension() {
        let mut bytes = b"ID3".to_vec();
        bytes.extend_from_slice(&[0u8; 16]);
        assert_eq!(
            sniff_bytes(&bytes, Path::new("fake.wav")).unwrap(),
            Sniff::Mp3
        );
    }
}
