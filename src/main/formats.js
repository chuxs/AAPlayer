'use strict';
// Extension lists taken from VLC (vlc-master/include/vlc_interface.h).
const VIDEO = '3g2 3gp 3gp2 3gpp amrec amv asf avi bik bin crf dav divx drc dv dvr-ms evo f4v flv gvi gxf iso k3g m1v m2v m2t m2ts m4v mkv mov mp2 mp2v mp4 mp4v mpe mpeg mpeg1 mpeg2 mpeg4 mpg mpv2 mts mtv mxf mxg nsv nuv ogg ogm ogv ogx ps qt rec rm rmvb rpl skm thp tod tp ts tts txd vob vp6 vro webm wm wmv wtv xesc'.split(' ');
const AUDIO = '3ga 669 a52 aac ac3 adt adts aif aifc aiff alac amb amr aob ape au awb caf dts dsf dff flac it kar m4a m4b m4p m5p mid mka mlp mod mpa mp1 mp2 mp3 mpc mpga mus oga ogg oma opus qcp ra rmi s3m sid spx tak thd tta voc vqf w64 wav wma wv xa xm'.split(' ');
const SUBTITLE = 'srt ass ssa vtt sub smi sami txt ttml dfxp stl mpl2 usf jss aqt pjs'.split(' ');
// Subtitle formats ffmpeg can convert to WebVTT for display.
const SUBTITLE_AUTOLOAD = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'smi', 'sami', 'ttml', 'dfxp', 'stl', 'mpl2', 'jss', 'aqt', 'pjs']);

const MEDIA = new Set([...VIDEO, ...AUDIO]);

module.exports = { VIDEO, AUDIO, SUBTITLE, SUBTITLE_AUTOLOAD, MEDIA };
