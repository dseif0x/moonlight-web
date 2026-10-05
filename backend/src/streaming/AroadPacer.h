/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

#include "SendPacer.h"

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace rtc {
class Track;
}

// The audio road's sender (POC Ultra U1.4 ter; plan « Wi-Fi », W4): the
// chunks of the frames sent on an Opus track, handed to libdatachannel at a
// paced rate by a thread of its own, instead of a frame's every chunk back to
// back from the capture thread.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// The road has neither SCTP's window nor Chrome's congestion control: a HEVC
// keyframe left as ~200 packets in one run. On a Mac in Wi-Fi (05/10/2026,
// 22:40), the kernel dropped 3,833 datagrams a pass for a full socket buffer,
// against 352 for SCTP, and the click went through 23 times out of 60. The
// pacing spreads a frame over a little of its interval; the other half of the
// answer is the rate governor, which hears of the road's resends with SCTP's
// retransmissions (DataChannelRelay, linkstats) and cuts the bitrate on them.
// W2 A is a warning: on SCTP, pacing alone did not lower the Mac's drops.
//
// ── The rate ────────────────────────────────────────────────────────────────
//
// `multiple` times what the road carried over the last second, never under
// `floorBytesPerSecond`, in bursts of `burstBytes` at most. A resend asked by
// the page goes before what waits: it is the oldest data the page wants.
class AroadPacer
{
public:
    /// @p multiple 0 sends everything at once (no pacing).
    AroadPacer(double multiple, int64_t floorBytesPerSecond, size_t burstBytes);
    ~AroadPacer();

    AroadPacer(const AroadPacer&) = delete;
    AroadPacer& operator=(const AroadPacer&) = delete;

    /// Queue one chunk for @p track, with its RTP timestamp. @p resend: ahead
    /// of the queue.
    void send(std::shared_ptr<rtc::Track> track, std::vector<std::byte> chunk, uint32_t timestamp,
              bool resend);

    /// The rate the pacer runs at now, bytes per second (0: unpaced).
    int64_t rateBytesPerSecond() const { return m_Rate.load(std::memory_order_relaxed); }
    /// The longest a chunk waited in the queue over the pacer's life, in µs.
    int64_t maxQueueUs() const { return m_MaxQueueUs.load(std::memory_order_relaxed); }

    /// The rate for @p carriedBytesPerSecond (pure: the tests'). 0 when the
    /// multiple is 0.
    static int64_t rateFor(double multiple, int64_t floorBytesPerSecond,
                           int64_t carriedBytesPerSecond)
    {
        if (multiple <= 0) return 0;
        const int64_t paced =
            static_cast<int64_t>(multiple * static_cast<double>(carriedBytesPerSecond));
        return paced > floorBytesPerSecond ? paced : floorBytesPerSecond;
    }

private:
    struct Job
    {
        std::shared_ptr<rtc::Track> track;
        std::vector<std::byte> chunk;
        uint32_t timestamp = 0;
        int64_t queuedUs = 0;
    };

    void run();
    void waitUs(int64_t us);

    const double m_Multiple;
    const int64_t m_Floor;
    const size_t m_Burst;
    std::mutex m_Mutex;
    std::condition_variable m_Cv;
    std::deque<Job> m_Queue;
    bool m_Stop = false;
    SendPacer m_Pacer;
    std::atomic<int64_t> m_Rate{0};
    std::atomic<int64_t> m_MaxQueueUs{0};
    int64_t m_WindowStartUs = 0;
    int64_t m_WindowBytes = 0;
    void* m_Timer = nullptr; // a high-resolution waitable timer, on Windows
    std::thread m_Thread;
};
