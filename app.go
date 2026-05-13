package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context)  { a.ctx = ctx }
func (a *App) shutdown(ctx context.Context) {}

// ── Data Types ───────────────────────────────────────────

type VideoInfo struct {
	Path     string  `json:"path"`
	Duration float64 `json:"duration"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	FPS      string  `json:"fps"`
	Bitrate  int64   `json:"bitrate"`
	VCodec   string  `json:"vcodec"`
	ACodec   string  `json:"acodec"`
	HasAudio bool    `json:"hasAudio"`
	Size     int64   `json:"size"`
}

type TimeRange struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// ProcessTask — 一次性描述所有编辑操作
type ProcessTask struct {
	InputPath        string      `json:"inputPath"`
	OutputPath       string      `json:"outputPath"`
	DeletedRanges    []TimeRange `json:"deletedRanges"`    // 要删除的片段
	AudioMode        string      `json:"audioMode"`        // "original" | "muted" | "replaced"
	ReplacementAudio string      `json:"replacementAudio"` // 替换音频路径
	VideoCodec       string      `json:"videoCodec"`       // "copy" | "libx264" | "libx265"
	VideoBitrate     string      `json:"videoBitrate"`     // "5000k" 等，空则用 CRF
	VideoCRF         int         `json:"videoCRF"`         // 18-28
	AudioBitrate     string      `json:"audioBitrate"`     // "128k"
	Format           string      `json:"format"`           // "mp4" | "mov" | "mkv" | "avi" | "webm"
}

// ffprobe JSON 结构
type ffprobeResult struct {
	Streams []struct {
		CodecType  string `json:"codec_type"`
		CodecName  string `json:"codec_name"`
		Width      int    `json:"width"`
		Height     int    `json:"height"`
		RFrameRate string `json:"r_frame_rate"`
		Duration   string `json:"duration"`
		BitRate    string `json:"bit_rate"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
		BitRate  string `json:"bit_rate"`
	} `json:"format"`
}

// ── 文件对话框 ────────────────────────────────────────────

func (a *App) OpenVideoFile() (string, error) {
	return wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "选择视频文件",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "视频文件", Pattern: "*.mp4;*.mov;*.avi;*.mkv;*.flv;*.wmv;*.webm;*.m4v"},
			{DisplayName: "所有文件", Pattern: "*.*"},
		},
	})
}

func (a *App) OpenAudioFile() (string, error) {
	return wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "选择音频文件",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "音频文件", Pattern: "*.mp3;*.aac;*.wav;*.flac;*.ogg;*.m4a"},
			{DisplayName: "所有文件", Pattern: "*.*"},
		},
	})
}

func (a *App) SaveVideoFile(defaultName, format string) (string, error) {
	patternMap := map[string]string{
		"mp4": "*.mp4", "mov": "*.mov", "mkv": "*.mkv",
		"avi": "*.avi", "webm": "*.webm",
	}
	pat, ok := patternMap[format]
	if !ok {
		pat = "*.mp4"
	}
	ext := strings.TrimPrefix(pat, "*")
	if !strings.HasSuffix(strings.ToLower(defaultName), ext) {
		defaultName = strings.TrimSuffix(defaultName, filepath.Ext(defaultName)) + ext
	}
	return wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "保存视频",
		DefaultFilename: defaultName,
		Filters:         []wailsRuntime.FileFilter{{DisplayName: format + " 视频", Pattern: pat}},
	})
}

// ── FFmpeg Detection & Installation ──────────────────────

func (a *App) getFFmpegPath() string {
	// 1. Check local bin folder
	localPath := filepath.Join("bin", "ffmpeg.exe")
	if _, err := os.Stat(localPath); err == nil {
		return localPath
	}
	// 2. Check system PATH
	p, err := exec.LookPath("ffmpeg")
	if err == nil {
		return p
	}
	return ""
}

func (a *App) getFFprobePath() string {
	localPath := filepath.Join("bin", "ffprobe.exe")
	if _, err := os.Stat(localPath); err == nil {
		return localPath
	}
	p, err := exec.LookPath("ffprobe")
	if err == nil {
		return p
	}
	return ""
}

func (a *App) CheckFFmpeg() bool {
	return a.getFFmpegPath() != "" && a.getFFprobePath() != ""
}

func (a *App) newCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

func (a *App) InstallFFmpeg() error {
	emit := func(pct int, msg string) {
		wailsRuntime.EventsEmit(a.ctx, "ffmpeg:install_progress", map[string]interface{}{
			"percent": pct,
			"message": msg,
		})
	}

	emit(5, "正在准备下载...")
	os.MkdirAll("bin", 0755)

	// 使用 GitHub 镜像源 (ghproxy)，通常在中国大陆访问更快
	// 选择 BtbN 的最新稳定版精简包
	url := "https://mirror.ghproxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip"
	// 或者 Gyan.dev 的镜像（如果能找到）
	// 这里我们改用 BtbN 的 master-latest-win64-gpl.zip，它包含静态二进制文件
	url = "https://mirror.ghproxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

	tmpZip := filepath.Join(os.TempDir(), "ffmpeg_temp.zip")

	emit(10, "正在从镜像源下载 FFmpeg (约 100MB)...")
	
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("下载失败: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败，服务器返回: %s", resp.Status)
	}

	out, err := os.Create(tmpZip)
	if err != nil {
		return err
	}
	defer out.Close()

	// Wrap reader to track progress
	contentLength := resp.ContentLength
	buffer := make([]byte, 32*1024)
	var downloaded int64
	
	for {
		n, err := resp.Body.Read(buffer)
		if n > 0 {
			out.Write(buffer[:n])
			downloaded += int64(n)
			if contentLength > 0 {
				pct := 10 + int(float64(downloaded)/float64(contentLength)*70)
				emit(pct, fmt.Sprintf("正在下载: %.1f MB / %.1f MB", float64(downloaded)/1024/1024, float64(contentLength)/1024/1024))
			}
		}
		if err != nil {
			break
		}
	}

	emit(85, "下载完成，正在解压并安装...")
	
	// Unzip and extract ffmpeg.exe, ffprobe.exe
	r, err := zip.OpenReader(tmpZip)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		if strings.HasSuffix(f.Name, "ffmpeg.exe") || strings.HasSuffix(f.Name, "ffprobe.exe") {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			destPath := filepath.Join("bin", filepath.Base(f.Name))
			dst, err := os.Create(destPath)
			if err != nil {
				rc.Close()
				return err
			}
			_, err = io.Copy(dst, rc)
			dst.Close()
			rc.Close()
			if err != nil {
				return err
			}
		}
	}

	os.Remove(tmpZip)
	emit(100, "FFmpeg 安装成功！")
	return nil
}

// ── 视频信息 ──────────────────────────────────────────────

func (a *App) GetVideoInfo(path string) (*VideoInfo, error) {
	ffprobe := a.getFFprobePath()
	if ffprobe == "" {
		return nil, fmt.Errorf("未找到 ffprobe，请先安装 FFmpeg 组件")
	}
	out, err := a.newCommand(ffprobe,
		"-v", "quiet", "-print_format", "json",
		"-show_format", "-show_streams", path,
	).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe 执行失败: %v", err)
	}
	var probe ffprobeResult
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("解析失败: %v", err)
	}

	info := &VideoInfo{Path: path}
	parseFloat := func(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
	parseInt64 := func(s string) int64 { v, _ := strconv.ParseInt(s, 10, 64); return v }

	info.Duration = parseFloat(probe.Format.Duration)
	info.Size = parseInt64(probe.Format.Size)
	info.Bitrate = parseInt64(probe.Format.BitRate)

	for _, s := range probe.Streams {
		switch s.CodecType {
		case "video":
			info.Width, info.Height = s.Width, s.Height
			info.VCodec = s.CodecName
			info.FPS = parseFPS(s.RFrameRate)
			if info.Duration == 0 {
				info.Duration = parseFloat(s.Duration)
			}
		case "audio":
			info.ACodec = s.CodecName
			info.HasAudio = true
		}
	}
	return info, nil
}

// ── 核心处理 ──────────────────────────────────────────────

// ProcessVideo 应用所有编辑并导出
func (a *App) ProcessVideo(task ProcessTask) error {
	ffmpeg := a.getFFmpegPath()
	if ffmpeg == "" {
		return fmt.Errorf("未找到 ffmpeg，请先安装 FFmpeg 组件")
	}

	// 获取视频时长
	info, err := a.GetVideoInfo(task.InputPath)
	if err != nil {
		return err
	}
	duration := info.Duration

	// 计算保留片段
	keptRanges := computeKeptRanges(duration, task.DeletedRanges)
	if len(keptRanges) == 0 {
		return fmt.Errorf("所有片段均被删除，请至少保留一段内容")
	}

	// 确保输出目录存在
	if err := os.MkdirAll(filepath.Dir(task.OutputPath), 0755); err != nil {
		return fmt.Errorf("创建输出目录失败: %v", err)
	}

	// 发送进度事件
	emit := func(pct int, msg string) {
		wailsRuntime.EventsEmit(a.ctx, "export:progress", map[string]interface{}{
			"percent": pct,
			"message": msg,
		})
	}

	// ── 情形1: 无删除 + audio original + 仅重编码/copy
	if len(task.DeletedRanges) == 0 && task.AudioMode == "original" {
		emit(10, "正在处理...")
		args := buildSimpleExportArgs(task)
		args = append(args, "-i", task.InputPath)
		args = append(args, buildVideoEncodeArgs(task)...)
		args = append(args, buildAudioEncodeArgs(task, false)...)
		args = append(args, "-y", task.OutputPath)
		if out, err := a.newCommand(ffmpeg, args...).CombinedOutput(); err != nil {
			return fmt.Errorf("导出失败: %v\n%s", err, string(out))
		}
		emit(100, "完成")
		return nil
	}

	// ── 情形2: 有删除操作 → 提取保留片段 → concat
	tmpDir, err := os.MkdirTemp("", "videocutter_*")
	if err != nil {
		return fmt.Errorf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	segFiles := []string{}
	total := len(keptRanges)

	for i, r := range keptRanges {
		emit(10+i*60/total, fmt.Sprintf("提取片段 %d/%d...", i+1, total))
		segPath := filepath.Join(tmpDir, fmt.Sprintf("seg_%03d.mp4", i))
		dur := r.End - r.Start
		out, err := a.newCommand(ffmpeg,
			"-ss", fmtSec(r.Start),
			"-i", task.InputPath,
			"-t", fmt.Sprintf("%.6f", dur),
			"-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
			"-c:a", "aac", "-b:a", "192k",
			"-avoid_negative_ts", "make_zero",
			"-y", segPath,
		).CombinedOutput()
		if err != nil {
			return fmt.Errorf("提取片段 %d 失败: %v\n%s", i, err, string(out))
		}
		segFiles = append(segFiles, segPath)
	}

	// 写 concat 列表
	emit(70, "合并片段...")
	concatListPath := filepath.Join(tmpDir, "concat.txt")
	var sb strings.Builder
	for _, f := range segFiles {
		sb.WriteString(fmt.Sprintf("file '%s'\n", strings.ReplaceAll(f, "'", "'\\''")))
	}
	if err := os.WriteFile(concatListPath, []byte(sb.String()), 0644); err != nil {
		return fmt.Errorf("写 concat 列表失败: %v", err)
	}

	// concat 到临时文件
	concatOut := filepath.Join(tmpDir, "concat_out.mp4")
	if out, err := a.newCommand(ffmpeg,
		"-f", "concat", "-safe", "0",
		"-i", concatListPath,
		"-c", "copy",
		"-y", concatOut,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("合并失败: %v\n%s", err, string(out))
	}

	// ── 处理音频 + 最终编码导出
	emit(85, "编码导出...")
	var finalArgs []string

	switch task.AudioMode {
	case "muted":
		finalArgs = append(finalArgs, "-i", concatOut)
		finalArgs = append(finalArgs, buildVideoEncodeArgs(task)...)
		finalArgs = append(finalArgs, "-an")

	case "replaced":
		if task.ReplacementAudio == "" {
			return fmt.Errorf("替换音频模式下未指定音频文件")
		}
		finalArgs = append(finalArgs, "-i", concatOut, "-i", task.ReplacementAudio)
		finalArgs = append(finalArgs, buildVideoEncodeArgs(task)...)
		finalArgs = append(finalArgs, buildAudioEncodeArgs(task, true)...)
		finalArgs = append(finalArgs, "-map", "0:v:0", "-map", "1:a:0", "-shortest")

	default: // original
		finalArgs = append(finalArgs, "-i", concatOut)
		finalArgs = append(finalArgs, buildVideoEncodeArgs(task)...)
		finalArgs = append(finalArgs, buildAudioEncodeArgs(task, false)...)
	}

	finalArgs = append(finalArgs, "-y", task.OutputPath)
	if out, err := a.newCommand(ffmpeg, finalArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("最终编码失败: %v\n%s", err, string(out))
	}

	emit(100, "导出完成！")
	return nil
}

// ── 辅助函数 ──────────────────────────────────────────────

func computeKeptRanges(duration float64, deleted []TimeRange) []TimeRange {
	// 合并并排序删除区间
	type seg = TimeRange
	merged := []seg{}
	for _, d := range deleted {
		start := math.Max(0, d.Start)
		end := math.Min(duration, d.End)
		if end <= start {
			continue
		}
		merged = append(merged, seg{start, end})
	}
	// 简单排序
	for i := 0; i < len(merged)-1; i++ {
		for j := i + 1; j < len(merged); j++ {
			if merged[j].Start < merged[i].Start {
				merged[i], merged[j] = merged[j], merged[i]
			}
		}
	}
	// 计算保留区间
	kept := []seg{}
	cur := 0.0
	for _, d := range merged {
		if d.Start > cur+0.001 {
			kept = append(kept, seg{cur, d.Start})
		}
		cur = d.End
	}
	if cur < duration-0.001 {
		kept = append(kept, seg{cur, duration})
	}
	return kept
}

func buildSimpleExportArgs(task ProcessTask) []string {
	return []string{} // input added by caller
}

func buildVideoEncodeArgs(task ProcessTask) []string {
	codec := task.VideoCodec
	if codec == "" {
		codec = "libx264"
	}
	if codec == "copy" {
		return []string{"-c:v", "copy"}
	}
	args := []string{"-c:v", codec}
	if task.VideoBitrate != "" {
		args = append(args, "-b:v", task.VideoBitrate)
	} else {
		crf := task.VideoCRF
		if crf == 0 {
			crf = 23
		}
		args = append(args, "-crf", strconv.Itoa(crf))
	}
	if codec == "libx264" || codec == "libx265" {
		args = append(args, "-preset", "fast")
	}
	return args
}

func buildAudioEncodeArgs(task ProcessTask, isReplacement bool) []string {
	if task.AudioMode == "muted" {
		return []string{"-an"}
	}
	ab := task.AudioBitrate
	if ab == "" {
		ab = "128k"
	}
	return []string{"-c:a", "aac", "-b:a", ab}
}

func fmtSec(s float64) string {
	h := int(s) / 3600
	m := (int(s) % 3600) / 60
	sec := s - float64(h*3600+m*60)
	return fmt.Sprintf("%02d:%02d:%09.6f", h, m, sec)
}

func parseFPS(r string) string {
	parts := strings.Split(r, "/")
	if len(parts) != 2 {
		return r
	}
	num, _ := strconv.ParseFloat(parts[0], 64)
	den, _ := strconv.ParseFloat(parts[1], 64)
	if den == 0 {
		return r
	}
	fps := num / den
	return strconv.FormatFloat(fps, 'f', 2, 64)
}
