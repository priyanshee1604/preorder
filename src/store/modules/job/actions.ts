import { ActionTree } from 'vuex'
import RootState from '@/store/RootState'
import JobState from './JobState'
import * as types from './mutation-types'
import { hasError, showToast } from '@/utils'
import { JobService } from '@/services/JobService'
import emitter from "@/event-bus"
import { translate } from '@/i18n/index'

const actions: ActionTree<JobState, RootState> = {

  async fetchJobs ( { commit }, payload) {
    const resp = await JobService.fetchJobs(payload)
    commit(types.JOB_LIST_UPDATED, {
      items: resp.data.docs ? resp.data.docs : [], // TODO Handled error & docs undefined when no record
      total: resp.data.count ? resp.data.count : 0 , //  TODO Handled error & count undefined when no record
      });
    // Removed Toast as it will also be async job
    // TODO Handle specific error
    return resp;
  },
  async fetchJobLogs ( { commit }, payload) {
    const resp = await JobService.fetchJobLogs(payload)
    commit(types.JOB_LOGS_UPDATED, {
      items: resp.data.docs ? resp.data.docs : [], // TODO Handled error & docs undefined when no record
      total: resp.data.count ? resp.data.count : 0 , //  TODO Handled error & count undefined when no record
      });
    // TODO Handle specific error
    return resp;
  },
  async fetchPolledJobs({ commit }) {
    const { jobResponse, logResponse } = await JobService.fetchBackgroundJobs();
    let backgroundJobCount = 0;
    if (jobResponse && jobResponse.status === 200 && !hasError(jobResponse)) {
      backgroundJobCount += jobResponse.data.count
    }
    if (logResponse && logResponse.status === 200 && !hasError(logResponse)) {
      backgroundJobCount += logResponse.data.count
    }
    // If we have any job or log in response then only go for polling
    if (backgroundJobCount) {
      commit(types.JOB_POLLING_UPDATED, {
        polling: true
      });
      JobService.pollJobs();
    } else {
      commit(types.JOB_POLLING_UPDATED, {
        polling: false
      });
      // Show user status that all background jobs are finished and product details page needs to be refreshed
      // TODO Try using polling in state to achieve the same
      emitter.emit("backgroundJobsFinished");
    }
    // TODO Handle specific error
    return { jobResponse, logResponse };
  },
  async initiatePollingJobs({ commit, state }) {
    if (!state.polling) {
      const { jobResponse, logResponse } = await JobService.fetchBackgroundJobs();
      let backgroundJobCount = 0;
      if (jobResponse && jobResponse.status === 200 && !hasError(jobResponse) && jobResponse.data.count) {
        backgroundJobCount += jobResponse.data.count
      }
      if (logResponse && logResponse.status === 200 && !hasError(logResponse) && logResponse.data.count) {
        backgroundJobCount += logResponse.data.count
      }

      // If we have any job or log in response then only go for polling
      if (backgroundJobCount) {
        commit(types.JOB_POLLING_UPDATED, {
          polling: true
        });
        JobService.pollJobs();
      } else {
        commit(types.JOB_POLLING_UPDATED, { 
          polling: false
        });
      }
      // TODO Handle specific error
      return { jobResponse, logResponse };
    }
  },
  async runJobNow({ dispatch }, job) {
    let resp
    const payload = {
      'JOB_NAME': job.jobName,
      'SERVICE_NAME': job.serviceName,
      'SERVICE_COUNT': '0',
      'SERVICE_TEMP_EXPR': job.jobStatus,
      'jobFields': {
        'productStoreId': job.productStoreId,
        'systemJobEnumId': job.systemJobEnumId,
        'tempExprId': job.jobStatus, // Need to remove this as we are passing frequency in SERVICE_TEMP_EXPR, currently kept it for backward compatibility
        'parentJobId': job.parentJobId,
        'recurrenceTimeZone': this.state.user.current.userTimeZone,
      },
      'statusId': "SERVICE_PENDING",
      'systemJobEnumId': job.systemJobEnumId
    } as any
    // checking if the runtimeData has productStoreId, and if present then adding it on root level
    job?.runtimeData?.productStoreId?.length >= 0 && (payload['productStoreId'] = job.productStoreId)
    job?.priority && (payload['SERVICE_PRIORITY'] = job.priority.toString())
    job?.sinceId && (payload['sinceId'] = job.sinceId)

    // assigning '' (empty string) to all the runtimeData properties whose value is "null"
    job.runtimeData && Object.keys(job.runtimeData).map((key: any) => {
      if (job.runtimeData[key] === 'null' ) job.runtimeData[key] = ''
    })

    try {
      resp = await JobService.scheduleJob({ ...job.runtimeData, ...payload });
      if (!hasError(resp)) {
        showToast(translate('Service has been scheduled'))
      } else {
        showToast(translate('Something went wrong'))
      }
    } catch (err) {
      showToast(translate('Something went wrong'))
      console.error(err)
    } finally {
      // refetching the jobs
      const systemJobEnumIds = JSON.parse(process.env.VUE_APP_CTGRY_AND_BRKRNG_JOB)
      await dispatch('fetchCtgryAndBrkrngJobs', { systemJobEnumIds })
    }
    return resp;
  },
  async cancelJob({ dispatch }, payload) {
    let resp
    try {
      resp = await JobService.cancelJob({ jobId: payload.jobId })
      if (!hasError(resp)) {
        showToast(translate('Job cancelled successfully'))
      } else {
        showToast(translate('Something went wrong, could not cancel the job'))
      }
    } catch (err) {
      showToast(translate('Something went wrong, could not cancel the job'))
      console.error(err)
    } finally {
      // refetching the jobs
      await dispatch('clearCtgryAndBrkrngJobs')
      const systemJobEnumIds = JSON.parse(process.env.VUE_APP_CTGRY_AND_BRKRNG_JOB)
      await dispatch('fetchCtgryAndBrkrngJobs', { systemJobEnumIds })
    }
    return resp
  },
  async fetchCtgryAndBrkrngJobs ({ commit }, payload) {
    const params = {
      "inputFields": {
        "statusId": "SERVICE_PENDING",
        "statusId_op": "equals",
        "productStoreId": this.state.user.currentEComStore?.productStoreId,
        'systemJobEnumId': payload.systemJobEnumIds,
        'systemJobEnumId_op': 'in'
      },
      "noConditionFind": "Y",
      "viewSize": payload.systemJobEnumIds.length,
    } as any

    let resp, jobs = [] as any
    try {
      resp = await JobService.fetchJobInformation(params)
      if (!hasError(resp)) {
        jobs = resp.data.docs
      }

      const pendingSysJobEnumIds = jobs.filter((job: any) => job.statusId === 'SERVICE_PENDING').map((job: any) => job.systemJobEnumId)
      await Promise.allSettled(pendingSysJobEnumIds.map(async (systemJobEnumId: string) => {
        const resp = await JobService.fetchJobInformation({
          "inputFields": {
            "productStoreId": this.state.user.currentEComStore?.productStoreId,
            'systemJobEnumId': systemJobEnumId,
            'systemJobEnumId_op': 'equals',
            "statusId": ["SERVICE_CANCELLED", "SERVICE_CRASHED", "SERVICE_FAILED", "SERVICE_FINISHED"],
            "statusId_op": "in",
          },
          // fetching statusId as well as only one field cannot be sent
          "fieldList": ["runTime", "systemJobEnumId"],
          "noConditionFind": "Y",
          "viewSize": 1,
          "orderBy": "runTime DESC"
        })
        
        if (!hasError(resp)) {
          const respJob = resp.data.docs[0]
          jobs.find((job: any) => {
            if (job.systemJobEnumId === respJob.systemJobEnumId) {
              job.lastRunTime = respJob.runTime
              return
            }
          })
          return Promise.resolve(resp);
        } else {
          return Promise.reject(resp);
        }
      }))
    } catch (error) {
      console.error(error)
    } finally {
      commit(types.JOB_CTGRY_AND_BRKRNG_UPDATED, { jobs })
    }
    return resp;
  },
  clearCtgryAndBrkrngJobs({commit}) {
    commit(types.JOB_CTGRY_AND_BRKRNG_UPDATED, { jobs: [] })
  }
}
export default actions;