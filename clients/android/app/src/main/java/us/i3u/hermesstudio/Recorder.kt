package us.i3u.hermesstudio

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Records a short voice note to an m4a file, which is then sent to the Studio
 * transcribe endpoint. AAC in an MP4 container is what every supported provider
 * accepts, and it keeps a phone recording small enough to upload quickly.
 */
class Recorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var target: File? = null

    val isRecording: Boolean get() = recorder != null

    fun start(): Boolean {
        if (recorder != null) return true
        val file = File(context.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
        val instance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        return runCatching {
            instance.setAudioSource(MediaRecorder.AudioSource.MIC)
            instance.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            instance.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            instance.setAudioSamplingRate(44_100)
            instance.setAudioEncodingBitRate(96_000)
            instance.setOutputFile(file.absolutePath)
            instance.prepare()
            instance.start()
            recorder = instance
            target = file
            true
        }.getOrElse {
            runCatching { instance.release() }
            recorder = null
            target = null
            false
        }
    }

    /** Returns the recorded bytes, or null when the take was empty or failed. */
    fun stop(): ByteArray? {
        val instance = recorder ?: return null
        val file = target
        recorder = null
        target = null

        runCatching { instance.stop() }
        runCatching { instance.release() }

        if (file == null || !file.exists()) return null
        val bytes = runCatching { file.readBytes() }.getOrNull()
        file.delete()
        // A tap that starts and stops immediately produces a header-only file.
        return bytes?.takeIf { it.size > 2_048 }
    }

    fun cancel() {
        val instance = recorder ?: return
        recorder = null
        runCatching { instance.stop() }
        runCatching { instance.release() }
        target?.delete()
        target = null
    }
}
