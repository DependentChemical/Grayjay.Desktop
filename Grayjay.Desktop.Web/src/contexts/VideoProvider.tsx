import { createContext, useContext, JSX, ParentComponent, createSignal, Accessor, batch, createMemo, onMount } from "solid-js";
import { shuffleArray, swap } from "../utility";
import { insertRandomlyAfter, shuffleAroundIndex } from "./queueShuffle";
import { IOrderedPlatformVideo, WatchLaterBackend } from "../backend/WatchLaterBackend";
import { IPlatformVideo } from "../backend/models/content/IPlatformVideo";
import { Duration } from "luxon";
import { SettingsBackend } from "../backend/SettingsBackend";
import StateWebsocket from "../state/StateWebsocket";
import { DetailsBackend, IVideoLoadResult } from "../backend/DetailsBackend";
import UIOverlay from "../state/UIOverlay";

const QUEUE_PERSIST_KEY = "playbackQueue";
interface PersistedQueue {
    v: 1;
    baseQueue: IPlatformVideo[];
    shuffledQueue?: IPlatformVideo[];
    index: number;
    repeat: boolean;
    state: VideoState;
}

export enum VideoState {
    Closed = 0,
    Maximized = 1,
    Minimized,
    Fullscreen
};

export enum VideoMode {
    Standard = 0,
    Theatre
};

export interface VideoContextState {
    state: VideoState;
    index?: number;
    queue?: IPlatformVideo[];
};

export interface VideoContextValue {
    state: Accessor<VideoState>;
    index: Accessor<number | undefined>;
    queue: Accessor<IPlatformVideo[] | undefined>;
    watchLater: Accessor<IOrderedPlatformVideo[] | undefined>;
    video: Accessor<IPlatformVideo | undefined>;
    repeat: Accessor<boolean>;
    shuffle: Accessor<boolean>;
    startTime: Accessor<Duration | undefined>;
    desiredMode: Accessor<VideoMode>;
    theatrePinned: Accessor<boolean>;
    volume: Accessor<number>;
    reopenCount: Accessor<number>;
    urlOpenCount: Accessor<number>;
    restorePaused: Accessor<boolean>;
    //queueType watch later, playlist en queue of undefined
    actions: {
        openVideo: (video: IPlatformVideo, time?: Duration, videoState?: VideoState) => void;
        openVideoByUrl: (url: string, time?: Duration, videoState?: VideoState) => void;
        setQueue: (index: number, queue: IPlatformVideo[], repeat?: boolean, shuffle?: boolean, videoState?: VideoState) => void;
        addToQueue: (v: IPlatformVideo) => void;
        removeFromQueue: (position: number) => void;
        swapInQueue: (index1: number, index2: number) => void;
        setIndex: (index: number) => void;
        setRepeat: (value: boolean) => void;
        setShuffle: (value: boolean) => void;
        closeVideo: () => void;
        setState: (videoState: VideoState) => void;
        refetchWatchLater: () => void;
        setDesiredMode: (mode: VideoMode) => void;
        setTheatrePinned: (pinned: boolean) => void;
        setVolume: (volume: number) => void;
        setStartTime: (startTime: Duration | undefined) => void;
        takePreloadedVideoLoad: (url: string) => IVideoLoadResult | undefined;
        clearRestorePaused: () => void;
    }
};

const VideoContext = createContext<VideoContextValue>();
export interface VideoContextProps {
    children: JSX.Element;
};

export const VideoProvider: ParentComponent<VideoContextProps> = (props) => {
    const [baseQueue, setBaseQueue] = createSignal<IPlatformVideo[] | undefined>();
    const [shuffledQueue, setShuffledQueue] = createSignal<IPlatformVideo[] | undefined>();
    const [index, setIndex] = createSignal<number | undefined>();
    const [startTime, setStartTime] = createSignal<Duration | undefined>();
    const [state, setState] = createSignal<VideoState>(VideoState.Closed);
    const [repeat, setRepeat] = createSignal<boolean>(false);
    const [desiredMode, setDesiredModeInternal] = createSignal<VideoMode>(VideoMode.Theatre);
    const [theatrePinned, setTheatrePinnedInternal] = createSignal<boolean>(true);
    const [volume, setVolumeInternal] = createSignal<number>(1);
    const [reopenCount, setReopenCount] = createSignal(0);
    const [urlOpenCount, setUrlOpenCount] = createSignal(0);
    const [restorePaused, setRestorePaused] = createSignal(false);
    const shuffle = () => shuffledQueue() !== undefined;
    const queue = createMemo(() => shuffledQueue() ?? baseQueue());
    const video = createMemo(() => {
        const q = queue();
        const i = index();
        if (!q || i === undefined || i < 0 || i >= q.length) {
            return undefined;
        }

        return q[i];
    });

    let queuePersistTimer: number | undefined;
    const clearRestorePaused = () => setRestorePaused(false);
    const normalizePersistedState = (videoState: VideoState) => {
        if (videoState === VideoState.Minimized || videoState === VideoState.Closed)
            return videoState;
        return VideoState.Maximized;
    };
    const persistQueueSnapshot = (immediate = false) => {
        if (queuePersistTimer !== undefined) {
            clearTimeout(queuePersistTimer);
            queuePersistTimer = undefined;
        }
        const write = () => {
            const q = queue();
            const i = index();
            const base = baseQueue();
            if (!q || !base || i === undefined || i < 0 || i >= q.length) {
                SettingsBackend.persistSet(QUEUE_PERSIST_KEY, null).catch(e => console.error("Failed to persist queue.", e));
                return;
            }
            const snapshot: PersistedQueue = {
                v: 1,
                baseQueue: base,
                shuffledQueue: shuffledQueue(),
                index: i,
                repeat: repeat(),
                state: normalizePersistedState(state())
            };
            SettingsBackend.persistSet(QUEUE_PERSIST_KEY, snapshot).catch(e => console.error("Failed to persist queue.", e));
        };
        if (immediate) {
            write();
            return;
        }
        queuePersistTimer = window.setTimeout(write, 300);
    };

    // Kept until the view takes it; valid only while its load is still the newest request.
    let preloadedVideoLoad: IVideoLoadResult | undefined;

    const openVideo = (v: IPlatformVideo, time?: Duration, videoState?: VideoState) => { 
        const desiredVideoState = videoState ?? VideoState.Maximized;
        batch(() => {
            setRestorePaused(false);
            setIndex(0);
            setStartTime(time);
            setBaseQueue([ v ]);
            setShuffledQueue(undefined);
            if (state() !== desiredVideoState)
                setState(desiredVideoState);
        });
        persistQueueSnapshot();
    };
    const openVideoByUrl = async (url: string, time?: Duration, videoState?: VideoState) => { 
        const desiredVideoState = videoState ?? VideoState.Maximized;
        setRestorePaused(false);
        if (state() !== desiredVideoState)
            setState(desiredVideoState);
        const requestId = DetailsBackend.nextVideoRequestId();
        setUrlOpenCount(count => count + 1);
        let videoLoadResult: IVideoLoadResult;
        try {
            videoLoadResult = await DetailsBackend.videoLoad(url, requestId);
        } catch (error) {
            if (index() !== undefined && DetailsBackend.isNewestVideoRequest(requestId)) {
                // The failed load released the open video's play token, so the view loads it again.
                setReopenCount(count => count + 1);
            }
            throw error;
        }
        if (videoLoadResult.superseded) {
            return;
        }

        const openVideoUrl = video()?.backendUrl ?? video()?.url;
        const loadedVideoUrl = videoLoadResult.video.backendUrl ?? videoLoadResult.video.url;
        preloadedVideoLoad = videoLoadResult;
        batch(() => {
            setIndex(0);
            setStartTime(time);
            setBaseQueue([ videoLoadResult.video ]);
            setShuffledQueue(undefined);
            if (openVideoUrl !== undefined && openVideoUrl === loadedVideoUrl) {
                // The load replaced the open video's sources, but the details view only reloads when the URL changes.
                setReopenCount(count => count + 1);
            }
        });
        persistQueueSnapshot();
    };
    const takePreloadedVideoLoad = (url: string): IVideoLoadResult | undefined => {
        const preloaded = preloadedVideoLoad;
        if (!preloaded || preloaded.requestId === undefined || !DetailsBackend.isNewestVideoRequest(preloaded.requestId)) {
            preloadedVideoLoad = undefined;
            return undefined;
        }

        if ((preloaded.video.backendUrl ?? preloaded.video.url) !== url) {
            return undefined;
        }

        preloadedVideoLoad = undefined;
        return preloaded;
    };
    const sq = (index: number, queue: IPlatformVideo[], repeat?: boolean, shuffleRequested?: boolean, videoState?: VideoState) => { 
        if (index < 0 || index >= queue.length) {
            console.error("index not valid for queue", {index, queue});
            return;
        }

        const desiredVideoState = videoState ?? VideoState.Maximized;
        const videos = [ ...queue ];
        batch(() => {
            setBaseQueue(videos);
            if (shuffleRequested === true) {
                setShuffledQueue(shuffleArray([ ...videos ]));
                setIndex(0);
            } else {
                setShuffledQueue(undefined);
                setIndex(index);
            }

            setStartTime(undefined);
            if (repeat !== undefined)
                setRepeat(repeat);
            if (state() !== desiredVideoState)
                setState(desiredVideoState);
        });
        persistQueueSnapshot();
    };
    const addToQueue = (video: IPlatformVideo) => { 
        const currentIndex = index();
        if (currentIndex === undefined) {
            openVideo(video);
            return;
        }

        const base = baseQueue() ?? [];
        if (base.some(item => item.url === video.url)) {
            UIOverlay.toast("Already queued");
            return;
        }

        batch(() => {
            setBaseQueue([ ...base, video ]);
            const shuffled = shuffledQueue();
            if (shuffled) {
                setShuffledQueue(insertRandomlyAfter(shuffled, currentIndex, video));
            }
        });
        persistQueueSnapshot();

        const name = video.name.length > 20 ? video.name.substring(0, 20) + "..." : video.name;
        UIOverlay.toast("Queued [" + name + "]");
    };
    const removeFromQueue = (position: number) => {
        const currentIndex = index();
        const activeQueue = queue();
        if (currentIndex === undefined || !activeQueue || position < 0 || position >= activeQueue.length) {
            return;
        }

        const removedVideo = activeQueue[position];
        const remaining = activeQueue.slice(0, position).concat(activeQueue.slice(position + 1));
        batch(() => {
            if (shuffledQueue()) {
                const base = baseQueue() ?? [];
                const basePosition = base.indexOf(removedVideo);
                setShuffledQueue(remaining);
                setBaseQueue(base.slice(0, basePosition).concat(base.slice(basePosition + 1)));
            } else {
                setBaseQueue(remaining);
            }

            const newIndex = currentIndex > position ? currentIndex - 1 : currentIndex;
            setIndex(Math.min(newIndex, remaining.length - 1));
            if (position === currentIndex) {
                setStartTime(undefined);
            }
        });
        persistQueueSnapshot();
    };
    const swapInQueue = (index1: number, index2: number) => {
        const activeQueue = queue();
        if (!activeQueue || index1 < 0 || index2 < 0 || index1 >= activeQueue.length || index2 >= activeQueue.length) {
            return;
        }

        batch(() => {
            if (shuffledQueue()) {
                setBaseQueue(activeQueue);
                setShuffledQueue(undefined);
            }

            // Swapped in place on purpose: VirtualDragDropList tracks rows by index mid-drag,
            // and a new array reference would make it remap them before applying the swap.
            swap(activeQueue, index1, index2);

            const currentIndex = index();
            if (currentIndex === index1) {
                setIndex(index2);
            } else if (currentIndex === index2) {
                setIndex(index1);
            }
        });
        persistQueueSnapshot();
    };
    const setShuffle = (value: boolean) => {
        const base = baseQueue();
        const currentVideo = video();
        if (!base || !currentVideo) {
            return;
        }

        const baseIndex = base.indexOf(currentVideo);
        batch(() => {
            setShuffledQueue(value ? shuffleAroundIndex(base, baseIndex) : undefined);
            setIndex(baseIndex);
        });
        persistQueueSnapshot();
    };
    const closeVideo = () => {
        if (index() !== undefined || DetailsBackend.isNewestVideoLoadPending()) {
            DetailsBackend.videoClose().catch((error) => console.warn("Failed to release the playback tracker", error));
        }
        batch(()=>{
            console.log("Closing video");
            setIndex(undefined);
            setBaseQueue(undefined);
            setShuffledQueue(undefined);
            setStartTime(undefined);
            setState(VideoState.Closed);
        });
        persistQueueSnapshot(true);
    };

    const refetchWatchLater = async () => {
        const videos = await WatchLaterBackend.getAll();
        setWatchLater(videos);
        console.log("set watch later", videos);
    }
    const [watchLater, setWatchLater] = createSignal<IOrderedPlatformVideo[]>();
    onMount(async () => {
        await refetchWatchLater();
    });

    const setDesiredMode = (mode: VideoMode) => {
        setDesiredModeInternal(mode);
        SettingsBackend.persistSet("desiredMode", mode);
    };

    const setTheatrePinned = (pinned: boolean) => {
        setTheatrePinnedInternal(pinned);
        SettingsBackend.persistSet("theatrePinned", pinned);
    };

    const setVolume = (volume: number) => {
        setVolumeInternal(volume);
        SettingsBackend.persistSet("volume", volume);
    };

    StateWebsocket.registerHandlerNew("WatchLaterChanged", (packet)=>{
        console.log("WatchLater changed");
        refetchWatchLater();
    }, "videoProvider");
    
    const value: VideoContextValue = {
        index,
        queue,
        watchLater,
        state,
        repeat,
        shuffle,
        video,
        startTime,
        desiredMode,
        theatrePinned,
        volume,
        reopenCount,
        urlOpenCount,
        restorePaused,
        actions: {
            setIndex: (i: number) => {
                batch(() => {
                    setIndex(i);
                    setStartTime(undefined);
                });
                persistQueueSnapshot();
            },
            openVideo,
            openVideoByUrl,
            setQueue: sq,
            closeVideo,
            addToQueue,
            removeFromQueue,
            swapInQueue,
            setState: (videoState: VideoState) => {
                console.info("VIDEO STATE CHANGED", videoState);
                setState(videoState);
                persistQueueSnapshot();
            },
            setRepeat: (value: boolean) => {
                setRepeat(value);
                persistQueueSnapshot();
            },
            setShuffle,
            setDesiredMode,
            setTheatrePinned,
            setVolume,
            refetchWatchLater,
            setStartTime,
            takePreloadedVideoLoad,
            clearRestorePaused
        }
    };

    SettingsBackend.persistGet("desiredMode", VideoMode.Theatre).then((r: VideoMode) => setDesiredModeInternal(r)).catch(e => console.error("Failed to get persistent setting 'desiredMode'.", e));
    SettingsBackend.persistGet("theatrePinned", true).then((r: boolean) => setTheatrePinnedInternal(r)).catch(e => console.error("Failed to get persistent setting 'theatrePinned'.", e));
    SettingsBackend.persistGet("volume", 1).then((r: number) => setVolumeInternal(r)).catch(e => console.error("Failed to get persistent setting 'volume'.", e));
    SettingsBackend.persistGet(QUEUE_PERSIST_KEY, null).then((saved: PersistedQueue | null) => {
        if (!saved || saved.v !== 1 || !Array.isArray(saved.baseQueue) || saved.baseQueue.length < 1)
            return;
        const base = saved.baseQueue;
        const active = Array.isArray(saved.shuffledQueue) ? saved.shuffledQueue : base;
        const savedIndex = typeof saved.index === "number" ? saved.index : -1;
        if (savedIndex < 0 || savedIndex >= active.length)
            return;
        if (Array.isArray(saved.shuffledQueue)) {
            const baseUrls = new Set(base.map(v => v?.url));
            if (saved.shuffledQueue.length !== base.length || saved.shuffledQueue.some(v => !v?.url || !baseUrls.has(v.url)))
                return;
        }
        batch(() => {
            setBaseQueue(base);
            setShuffledQueue(Array.isArray(saved.shuffledQueue) ? saved.shuffledQueue : undefined);
            setIndex(savedIndex);
            setRepeat(saved.repeat === true);
            setStartTime(undefined);
            setState(normalizePersistedState(saved.state));
            setRestorePaused(true);
        });
    }).catch(e => console.error("Failed to restore persisted queue.", e));

    return (
        <VideoContext.Provider value={value}>
            {props.children}
        </VideoContext.Provider>
    );
}

export function useVideo() { return useContext(VideoContext); }