export namespace main {
	
	export class TimeRange {
	    start: number;
	    end: number;
	
	    static createFrom(source: any = {}) {
	        return new TimeRange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.start = source["start"];
	        this.end = source["end"];
	    }
	}
	export class ProcessTask {
	    inputPath: string;
	    outputPath: string;
	    deletedRanges: TimeRange[];
	    audioMode: string;
	    replacementAudio: string;
	    videoCodec: string;
	    videoBitrate: string;
	    videoCRF: number;
	    audioBitrate: string;
	    format: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessTask(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inputPath = source["inputPath"];
	        this.outputPath = source["outputPath"];
	        this.deletedRanges = this.convertValues(source["deletedRanges"], TimeRange);
	        this.audioMode = source["audioMode"];
	        this.replacementAudio = source["replacementAudio"];
	        this.videoCodec = source["videoCodec"];
	        this.videoBitrate = source["videoBitrate"];
	        this.videoCRF = source["videoCRF"];
	        this.audioBitrate = source["audioBitrate"];
	        this.format = source["format"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class VideoInfo {
	    path: string;
	    duration: number;
	    width: number;
	    height: number;
	    fps: string;
	    bitrate: number;
	    vcodec: string;
	    acodec: string;
	    hasAudio: boolean;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new VideoInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.duration = source["duration"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.fps = source["fps"];
	        this.bitrate = source["bitrate"];
	        this.vcodec = source["vcodec"];
	        this.acodec = source["acodec"];
	        this.hasAudio = source["hasAudio"];
	        this.size = source["size"];
	    }
	}

}

